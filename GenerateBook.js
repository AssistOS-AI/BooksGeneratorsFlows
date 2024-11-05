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
                            prompt = `Please convert the following string into a json string:"${jsonString}".
                             Only respond with a valid Json that doesn't contain any code blocks or the \`\`\`json syntax.`;
                        } else {
                            prompt = `Please convert the following string into a json string:${jsonString}.
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

            const generateParagraphSchema = {
                text: "String"
            };

            const createParagraphPrompt = (bookData, chapterData, paragraphIdea) => {
                const base = `Your purpose is to write a comprehensive and detailed paragraph that is within a chapter of a book with the following specifications:`;
                const paragraphTemplate=`Your response should only and only match this Structure in all circumstances: ${JSON.stringify(generateParagraphSchema)}. It should be a json string with a text field`;
                const bookPrompt = `Details about the Book:${JSON.stringify(bookData)}`
                const chapterPrompt = `Details about the Chapter:${JSON.stringify(chapterData)}`;
                const paragraphPrompt = `The paragraph should be about and expand on this idea: ${paragraphIdea}.`;

                return [base, paragraphTemplate,bookPrompt, chapterPrompt, paragraphPrompt].join("\n");
            };
            const templateDocument = await documentModule.getDocument(parameters.spaceId, parameters.configs.documentId);

            let bookDocument={
                title: templateDocument.title.replace("template_", "book_"),
                abstract: templateDocument.abstract,
            }

            const documentId = await documentModule.addDocument(parameters.spaceId, bookDocument);


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
                    const paragraphId = await documentModule.addParagraph(parameters.spaceId, documentId, chapterId, {text: "Generating...",id:paragraph.id});
                    paragraphTasks.push(() => retryAsync(async () => {
                        try {
                            const paragraphGenerationPrompt = createParagraphPrompt(JSON.parse(templateDocument.abstract), chapterData, paragraph.text);
                            await applicationModule.runApplicationFlow(parameters.spaceId, "BooksGenerator", "ExpandParagraph", {
                                spaceId:parameters.spaceId,
                                prompt:paragraphGenerationPrompt,
                                bookData:templateDocument.abstract,
                                documentId:documentId,
                                chapterId:chapterId,
                                chapterTitle:chapter.title,
                                chapterIdea:chapter.idea,
                                paragraphId:paragraphId,
                                paragraphSchema:generateParagraphSchema
                            })
                        } catch (error) {
                            /* mark the paragraph as failed to generate */
                        }
                    }));
                }
            }
            apis.success(documentId);
            await rateLimiter(paragraphTasks, 10);

        } catch (e) {
            apis.fail(e);
        }
    }
}

module.exports = GenerateBook;
