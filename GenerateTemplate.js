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
                        const response = await llmModule.sendLLMRequest({
                            prompt,
                            modelName: "o1-mini"
                        }, parameters.spaceId);
                        return response.messages[0];
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
                const base = "You're a book content Manager. Your purpose is to generate a list of paragraphs based on user specifications" +
                    ` which will be part of a chapter used to create a book. Your response should match this json schema: ${JSON.stringify(generationTemplateStructure)}.
                    Please respect the number of paragraphs mentioned in the book data`
                const bookInfo = `Book data: ${JSON.stringify(bookData)}`;
                const chapterInfo = `Chapter data: ${JSON.stringify(chapterData)}`;
                const overrideParagraphCountBias = "If you have any bias towards the number of paragraphs you're inclined to generate, revoke it. " +
                    "Under no circumstance will you generate more or less paragraphs than the book data specifies(ideas per chapters)";
                return [base, bookInfo, chapterInfo, overrideParagraphCountBias].join("\n");
            };
            const generationTemplateParagraphs = {
                paragraphs: [
                    {
                        "idea": "String"
                    }
                ]
            };

            const getBookChaptersSchema = async () => {
                const llmResponse = await llmModule.sendLLMRequest({
                    prompt: bookGenerationPrompt,
                    modelName: "o1-mini"
                }, parameters.spaceId);
                const chaptersJsonString = await ensureValidJson(llmResponse.messages[0], 5);
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

            const chapters = await getBookChaptersSchema();

            for (const chapter of chapters.chapters) {
                const paragraphsPrompt = createParagraphsPrompt(generationTemplateParagraphs, bookData, chapter);
                applicationModule.runApplicationFlow(parameters.spaceId, "BooksGenerator", "GenerateChapterTemplate", {
                    spaceId: parameters.spaceId,
                    prompt: paragraphsPrompt,
                    bookData: bookData,
                    documentId: documentId,
                    chapterTitle: chapter.title,
                    chapterIdea: chapter.idea
                })
            }
        } catch (e) {
            apis.fail(e);
        }
    }
}

module.exports = GenerateTemplate;
