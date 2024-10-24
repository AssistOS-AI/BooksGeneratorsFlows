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
                        if (jsonSchema !== null) {
                            const prompt = `Please correct the following JSON to match the schema ${JSON.stringify(jsonSchema)}:
                             ${jsonString}. Only respond with a valid Json that doesn't contain any code blocks or the \`\`\`json syntax.`;
                            const response = await llmModule.sendLLMRequest({
                                prompt,
                                modelName: "GPT-4o"
                            }, parameters.spaceId);
                            return response.messages[0];
                        }
                        return jsonString;
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

            const createChaptersPrompt = (generationTemplateStructure, bookData, bookGenerationInfo, generalLlmInfo) => {
                const base = "You're a book content Manager. Your purpose is to generate a book schema template based on user specifications" +
                    ` which will be used to create a book. Your response should match this json schema: ${JSON.stringify(generationTemplateStructure)}.
                    Under no circumstance should your response include any other information than the json response schema.
                    Please give me a JSON response without including any code blocks or the \`\`\`json syntax.`;
                const specialInstructions = `Special Configuration: ${generalLlmInfo}`;
                const bookDataInstructions = `Book Generation Specifications: ${bookGenerationInfo}`;
                const bookInfo = `Book data: ${JSON.stringify(bookData)}`;

                return [base, specialInstructions, bookDataInstructions, bookInfo].join("\n");
            };

            const createParagraphsPrompt = (generationTemplateStructure, bookData, chapterData, bookGenerationInfo, generalLlmInfo) => {
                const base = "You're a book content Manager. Your purpose is to generate a list of paragraphs based on user specifications" +
                    ` which will be part of a chapter used to create a book. Your response should match this json schema: ${JSON.stringify(generationTemplateStructure)}.
                    But keep in mind that the number of paragraphs is variable and can be as many as you think is best for the chapter (even 1000).`;
                const specialInstructions = `Special Configuration: ${generalLlmInfo}`;
                const bookDataInstructions = `General Book Generation Specifications: ${bookGenerationInfo}`;
                const bookInfo = `Book data: ${JSON.stringify(bookData)}`;
                const chapterInfo = `Chapter data: ${JSON.stringify(chapterData)}`;
                const overrideParagraphCountBias = "If you have any bias towards the number of paragraphs you're inclined to generate, revoke it. " +
                    "You should generate the number of paragraphs that you think is best for the chapter, and keep in mind this is the chapter of a book." +
                    " And a chapter can have even 1000 paragraphs.";
                return [base, specialInstructions, bookDataInstructions, bookInfo, chapterInfo, overrideParagraphCountBias].join("\n");
            };

            const generationTemplateChapters = {
                chapters: [
                    {
                        title: "String",
                        idea: "String",
                    }
                ]
            };

            const generationTemplateParagraphs = {
                paragraphs: [
                    {
                        "idea": "String"
                    }
                ]
            };

            const bookGenerationInfo = parameters.configs.informativeText;
            const generalLlmInfo = parameters.configs.prompt;

            const bookData = parameters.configs;

            const documentObj = {
                title: `template_${bookData.title}`,
                abstract: JSON.stringify({
                    ...bookData,
                    generationInfo: bookGenerationInfo,
                    llmInfo: generalLlmInfo
                }),
            };
            const documentId = await documentModule.addDocument(parameters.spaceId, documentObj);

            apis.success(documentId);

            const chaptersPrompt = createChaptersPrompt(generationTemplateChapters, bookData, bookGenerationInfo, generalLlmInfo);

            const llmResponse = await llmModule.sendLLMRequest({
                prompt: chaptersPrompt,
                modelName: "GPT-4o"
            }, parameters.spaceId);

            const chaptersJsonString = await ensureValidJson(llmResponse.messages[0], 5, generationTemplateChapters);

            const chapters = JSON.parse(chaptersJsonString);
            for (const chapter of chapters.chapters) {
                    const chapterObj = {
                        title: chapter.title,
                        idea: chapter.idea,
                    };
                    const chapterId = await documentModule.addChapter(parameters.spaceId, documentId, chapterObj);

                    const paragraphsPrompt = createParagraphsPrompt(generationTemplateParagraphs, bookData, chapter, bookGenerationInfo, generalLlmInfo);

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
