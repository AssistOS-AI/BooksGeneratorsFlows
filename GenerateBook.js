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
                const bookPrompt = `The book is titled "${bookData.title}". A description about the books' content: ${bookData.informativeText}.Make sure you do the task that is required and nothing else`;
                const chapterPrompt = `The chapter is titled "${chapterData.title}", and the chapter is about: ${chapterData.idea}.`;
                const specializedLlmInstructions = `General generation instructions for the book generation: ${bookData.prompt}`;
                const paragraphPrompt = `The paragraph should be about and expand on this idea: ${paragraphIdea}.`;

                return [base, specializedLlmInstructions, bookPrompt, chapterPrompt, paragraphPrompt].join("\n");
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

            const retryAsync = async (fn, retries = 3, delay = 2000) => {
                for (let attempt = 1; attempt <= retries; attempt++) {
                    try {
                        return await fn();
                    } catch (error) {
                        if (attempt < retries) {
                            console.warn(`------------------------------Attempt ${attempt} failed. Retrying in ${delay}ms...------------------------------`);
                            await new Promise(resolve => setTimeout(resolve, delay));
                        } else {
                            console.error(`------------------------------All ${retries} attempts failed for function ${fn.name}.------------------------------`);
                            throw error;
                        }
                    }
                }
            };

            const rateLimiter = async (tasks, limitPerSecond) => {
                const totalTasks = tasks.length;
                let completedTasks = 0;
                console.info(`------------------------------Rate limiting ${totalTasks} tasks to ${limitPerSecond} per second------------------------------`);
                const taskQueue = [...tasks];
                let results = [];

                while (taskQueue.length > 0) {
                    const currentBatch = taskQueue.splice(0, limitPerSecond);
                    results = results.concat(await Promise.all(currentBatch.map(task => task())));
                    completedTasks += currentBatch.length;
                    console.info(`------------------------------Completed ${completedTasks} out of ${totalTasks} tasks------------------------------`);
                }

                return results;
            };

            let paragraphTasks = [];

            for (const chapter of templateDocument.chapters) {
                const chapterData = {
                    title: chapter.title,
                    idea: chapter.idea,
                };
                const chapterId = await documentModule.addChapter(parameters.spaceId, documentId, chapterData);

                for (const paragraph of chapter.paragraphs) {
                    const paragraphId = await documentModule.addParagraph(parameters.spaceId, documentId, chapterId, {text: paragraph.text});
                    paragraphTasks.push(() => retryAsync(async () => {
                        try {
                            const paragraphGenerationPrompt = createParagraphPrompt(abstract, chapterData, paragraph.text);
                            let response = await llmModule.sendLLMRequest({
                                prompt: paragraphGenerationPrompt,
                                modelName: "GPT-4o"
                            }, parameters.spaceId);
                            let paragraphJsonString;

                            try {
                                paragraphJsonString = await ensureValidJson(response.messages[0], 5, generateParagraphSchema);
                            } catch (error) {
                                response = await llmModule.sendLLMRequest({
                                    prompt: paragraphGenerationPrompt,
                                    modelName: "GPT-4o"
                                }, parameters.spaceId);
                                paragraphJsonString = await ensureValidJson(response.messages[0], 5, generateParagraphSchema);
                            }

                            const paragraphGenerated = JSON.parse(paragraphJsonString);
                            paragraphGenerated.id = paragraphId;

                            await documentModule.updateParagraph(parameters.spaceId, documentId, paragraphId, paragraphGenerated);
                            return paragraphGenerated;
                        } catch (error) {
                            /* mark the paragraph as failed to generate */
                        }
                    }));
                }
            }

            await rateLimiter(paragraphTasks, 3);

        } catch (e) {
            apis.fail(e);
        }
    }
}

module.exports = GenerateBook;
