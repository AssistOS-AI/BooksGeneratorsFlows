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
            const applicationModule = apis.loadModule("application");
            const llmModule = apis.loadModule("llm");
            const documentModule = apis.loadModule("document");
            const utilModule = apis.loadModule("util");

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
                            modelName: "GPT-4o"
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

            const createParagraphsPrompt = (generationTemplateStructure, bookData, chapterData) => {
                const base = "You're a book content Manager. Your purpose is to generate a list of paragraphs based on user specifications" +
                    ` which will be part of a chapter used to create a book. Your response should match this json schema: ${JSON.stringify(generationTemplateStructure)}.
                    Please respect the number of paragraphs mentioned in the book data`
                const bookInfo = `Book data: ${JSON.stringify(bookData)}`;
                const chapterInfo = `Chapter data: ${JSON.stringify(chapterData)}`;
                const overrideParagraphCountBias = "If you have any bias towards the number of paragraphs you're inclined to generate, revoke it. " +
                    "You should generate the number of paragraphs that you think is best for the chapter, and keep in mind this is the chapter of a book." +
                    " And a chapter can have even 1000 paragraphs.";
                return [base, bookInfo, chapterInfo, overrideParagraphCountBias].join("\n");
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
            const generationTemplateParagraphs = {
                paragraphs: [
                    {
                        "idea": "String"
                    }
                ]
            };

            const documentObj = {
                title: `template_${parameters.configs.title}`,
                abstract: JSON.stringify({
                    ...parameters.configs
                }),
            };

            parameters.configs=removeEmptyFields(parameters.configs);
            parameters.configs=convertIntFields(parameters.configs);
            parameters.configs=unsanitizeObj(parameters.configs);

            const bookGenerationPrompt = parameters.configs["review-prompt"];
            delete parameters.configs["review-prompt"];
            let bookData = parameters.configs;

            const documentId = await documentModule.addDocument(parameters.spaceId, documentObj);

            apis.success(documentId);

            const llmResponse = await llmModule.sendLLMRequest({
                prompt: bookGenerationPrompt,
                modelName: "GPT-4o"
            }, parameters.spaceId);

            const chaptersJsonString = await ensureValidJson(llmResponse.messages[0], 5);

            const chapters = JSON.parse(chaptersJsonString);
            for (const chapter of chapters.chapters) {
                const chapterObj = {
                    title: chapter.title,
                    idea: chapter.idea,
                };
                const chapterId = await documentModule.addChapter(parameters.spaceId, documentId, chapterObj);

                const paragraphsPrompt = createParagraphsPrompt(generationTemplateParagraphs, bookData, chapter);

                const llmResponse = await llmModule.sendLLMRequest({
                    prompt: paragraphsPrompt,
                    modelName: "GPT-4o"
                }, parameters.spaceId);

                const paragraphsJsonString = await ensureValidJson(llmResponse.messages[0], 5, generationTemplateParagraphs);
                const paragraphsData = JSON.parse(paragraphsJsonString);

                for (const paragraph of paragraphsData.paragraphs) {
                    const paragraphObj = {
                        text: paragraph.idea,
                    };
                    await documentModule.addParagraph(parameters.spaceId, documentId, chapterId, paragraphObj);
                }
            }
        } catch (e) {
            apis.fail(e);
        }
    }
}

module.exports = GenerateTemplate;
