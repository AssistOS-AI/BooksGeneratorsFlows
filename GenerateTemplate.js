const IFlow = require('assistos').loadModule('flow', {}).IFlow;

class GenerateTemplate extends IFlow {
    static flowMetadata = {
        action: "Generate a Book Template",
        intent: "Generates a Book Template"
    };

    static flowParametersSchema = {
        title: {
            type: "string",
            required: false
        },
        edition: {
            type: "string",
            required: false
        },
    };

    constructor() {
        super();
    }

    async userCode(apis, parameters) {
        try {
            const llmModule = apis.loadModule("llm");
            const documentModule = apis.loadModule("document");
            const utilModule = apis.loadModule("util");
            const applicationModule = apis.loadModule("application");

            const ensureValidJson = async (jsonString, maxIterations = 1, jsonSchema = null) => {
                const phases = {
                    "RemoveOutsideJson": async (jsonString) => {
                        if (jsonString.includes("```json")) {
                            jsonString = jsonString.split("```json")[1];
                            jsonString = jsonString.split("```")[0];
                        }
                        return jsonString;
                    },
                    "RemoveJsonMark": async (jsonString) => {
                        if (jsonString.startsWith("```json")) {
                            jsonString = jsonString.slice(7);
                            jsonString = jsonString.slice(0, -3);
                        }
                        return jsonString;
                    },
                    "RemoveNewLine": async (jsonString) => {
                        return jsonString.replace(/\n/g, "");
                    },
                    "TrimSpaces": async (jsonString) => {
                        return jsonString.trim();
                    },
                    "LlmHelper": async (jsonString) => {
                        let prompt;
                        if (!jsonSchema) {
                            prompt = `Please convert the following string into a json:${jsonString}.
                             Only respond with a valid Json that doesn't contain any code blocks or the \`\`\`json syntax.`;
                        } else {
                            prompt = `Please convert the following string into a json:${jsonString}.
                             Only respond with a valid Json that doesn't contain any code blocks or the \`\`\`json syntax.
                             Your response should match this json schema: ${JSON.stringify(jsonSchema)}`;
                        }
                        const response= await llmModule.generateText(parameters.spaceId, prompt, parameters.personality)
                        return response.message;
                    }
                };

                const phaseFunctions = Object.values(phases);

                while (maxIterations > 0) {
                    for (const phase of phaseFunctions) {
                        try {
                            JSON.parse(jsonString);
                            return jsonString;
                        } catch (error) {
                            jsonString = await phase(jsonString);
                        }
                    }
                    maxIterations--;
                }
                throw new Error("Unable to ensure valid JSON after all phases.");
            };
            const removeEmptyFields = (obj) => {
                Object.keys(obj).forEach(key => {
                    if (!obj[key]) {
                        delete obj[key];
                    }
                });
                return obj;
            }
            const convertIntFields = (obj) => {
                Object.keys(obj).forEach(key => {
                    if (parseInt(obj[key])) {
                        obj[key] = parseInt(obj[key]);
                    }
                });
                return obj;
            }
            const unsanitizeObj = (obj) => {
                Object.keys(obj).forEach(key => {
                    if (typeof obj[key] === "string") {
                        obj[key] = utilModule.unsanitize(obj[key]);
                    }
                });
                return obj;
            }

            const addDocumentTemplate = async (parameters) => {
                const documentObj = {
                    title: `template_${parameters.configs.title}`,
                    abstract: JSON.stringify({
                        ...parameters.configs
                    }),
                };
                return await documentModule.addDocument(parameters.spaceId, documentObj);
            }

            const createParagraphsPrompt = (generationTemplateStructure, bookData, chapterData) => {
                const base = `You are a book content manager. Your task is to generate a list of paragraphs based on the user specifications, which will be part of a chapter in a book.

                **Instructions**:
                - Output your response **only** in JSON format matching the following schema:
                ${JSON.stringify(generationTemplateStructure, null, 2)}
                
                - **Do not** include any text outside of the JSON output.
                - Generate **exactly** the number of paragraphs specified in the book data (ideas per chapter).
                - **Ignore any personal biases** toward the number of paragraphs.
                
                **Book Data**:
                ${JSON.stringify(bookData, null, 2)}
                
                **Chapter Data**:
                ${JSON.stringify(chapterData, null, 2)}
                
                Please generate the JSON output now.`;

                return base;
            };

            const generationTemplateParagraphs = {
                paragraphs: [
                    {
                        "idea": "String"
                    }
                ]
            };

            const getBookChaptersSchema = async () => {
                let llmResponse = await llmModule.generateText(parameters.spaceId, bookGenerationPrompt,parameters.personality)
                llmResponse = llmResponse.message
                const chaptersJsonString = await ensureValidJson(llmResponse, 5);
                return JSON.parse(chaptersJsonString);
            }

            parameters.configs = removeEmptyFields(parameters.configs);
            parameters.configs = convertIntFields(parameters.configs);
            parameters.configs = unsanitizeObj(parameters.configs);

            const bookGenerationPrompt = parameters.configs["review-prompt"];
            delete parameters.configs["review-prompt"];
            const bookData = parameters.configs;

            const documentId = await addDocumentTemplate(parameters);
            apis.success(documentId);

            let chapters = await getBookChaptersSchema();
            chapters = chapters.chapters || chapters;

            let chapterIds = []
            for (const chapter of chapters) {
                chapterIds.push(await documentModule.addChapter(parameters.spaceId, documentId, chapter));
            }
            let chapterPromises = [];
            for (let index = 0; index < chapters.length; index++) {
                chapterPromises.push((async () => {
                    let retries = 5;
                    const paragraphsPrompt = createParagraphsPrompt(generationTemplateParagraphs, bookData, chapters[index]);
                    while (retries > 0) {
                        try {
                            await applicationModule.runApplicationFlow(parameters.spaceId, "BooksGenerator", "GenerateChapterTemplate", {
                                spaceId: parameters.spaceId,
                                prompt: paragraphsPrompt,
                                bookData: bookData,
                                documentId: documentId,
                                chapterId: chapterIds[index],
                                chapterPosition: index,
                                chapterTitle: chapters[index].title,
                                chapterIdea: chapters[index].idea
                            });
                            break;
                        } catch (e) {
                            retries--;
                        }
                    } //fails silently
                    if (retries === 0) {
                        await documentModule.addParagraph(parameters.spaceId, documentId, chapterIds[index], {text: "Failed to generate chapter template"});
                    }
                })());
            }
            await Promise.all(chapterPromises);
        } catch (e) {
            apis.fail(e);
        }
    }
}

module.exports = GenerateTemplate;
