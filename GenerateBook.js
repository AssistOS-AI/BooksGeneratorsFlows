const IFlow = require('assistos').loadModule('flow', {}).IFlow;

class GenerateBook extends IFlow {
    static flowMetadata = {
        action: "Generate a Book",
        intent: "Generates a Book"
    };

    static flowParametersSchema = {};

    constructor() {
        super();
    }

    async userCode(apis, parameters) {
        try {
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
                            ${jsonString}. Only respond with a valid JSON that doesn't contain any code blocks or the \`\`\`json syntax.`;
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

            const createParagraphPrompt = (bookData, chapterData, paragraphIdea) => {
                const base = `Your purpose is to write a comprehensive and detailed paragraph that is within a chapter of a book with the following specifications:`;
                const bookPrompt = `The book is titled "${bookData.title}". Book content description: ${bookData.informativeText}.`;
                const chapterPrompt = `The chapter is titled "${chapterData.title}", and the chapter is about: ${chapterData.idea}.`;
                const paragraphPrompt = `The paragraph should be about: ${paragraphIdea}.`;
                const specializedLlmInstructions = `Custom instructions: ${bookData.prompt}`;
                return [base, bookPrompt, chapterPrompt, paragraphPrompt, specializedLlmInstructions].join("\n");
            };

            const llmModule = apis.loadModule("llm");
            const documentModule = apis.loadModule("document");
            const utilModule = apis.loadModule("util");

            const templateDocument = await documentModule.getDocument(parameters.spaceId, parameters.configs.documentId);

            const generateParagraphSchema = {
                text: "String"
            };

            const documentData = {
                title: templateDocument.title.replace("template_", "book_"),
                abstract: templateDocument.abstract,
            };

            const abstract = JSON.parse(templateDocument.abstract);
            Object.keys(abstract).forEach((key) => {
                if (typeof abstract[key] === "string") {
                    abstract[key] = utilModule.unsanitize(abstract[key]);
                }
            });

            const documentId = await documentModule.addDocument(parameters.spaceId, documentData);
            apis.success(documentId);

            for (const chapter of templateDocument.chapters) {
                const chapterData = {
                    title: chapter.title,
                    idea: chapter.idea,
                };
                const chapterId = await documentModule.addChapter(parameters.spaceId, documentId, chapterData);

                const paragraphPromises = chapter.paragraphs.map(async (paragraph) => {
                    const paragraphData = {
                        text: paragraph.text,
                    };
                    const paragraphId = await documentModule.addParagraph(parameters.spaceId, documentId, chapterId, paragraphData);

                    const paragraphGenerationPrompt = createParagraphPrompt(abstract, chapterData, paragraph.text);

                    const response = await llmModule.sendLLMRequest({
                        prompt: paragraphGenerationPrompt,
                        modelName: "GPT-4o"
                    }, parameters.spaceId);

                    const paragraphJsonString = await ensureValidJson(response.messages[0], 5, generateParagraphSchema);

                    const paragraphGenerated = JSON.parse(paragraphJsonString);

                    await documentModule.updateParagraph(parameters.spaceId, documentId, paragraphId, paragraphGenerated);
                });

                await Promise.all(paragraphPromises);
            }
        } catch (e) {
            apis.fail(e);
        }
    }
}

module.exports = GenerateBook;
