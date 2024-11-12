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
                        const response = await llmModule.generateText({
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

            const generateParagraphSchema = {
                text: "String"
            };

            const createParagraphPrompt = (bookData, chapterData, paragraphIdea) => {
                const base = `Your purpose is to write a comprehensive and detailed paragraph that is within a chapter of a book with the following specifications:`;
                const paragraphTemplate = `Your response should only and only match this Structure in all circumstances: ${JSON.stringify(generateParagraphSchema)}. It should be a json string with a text field`;
                const bookPrompt = `Details about the Book:${bookData}`
                const chapterPrompt = `Details about the Chapter:${JSON.stringify(chapterData)}`;
                const paragraphPrompt = `The paragraph should be about and expand on this idea: ${paragraphIdea}.`;

                return [base, paragraphTemplate, bookPrompt, chapterPrompt, paragraphPrompt].join("\n");
            };

            const templateDocument = await documentModule.getDocument(parameters.spaceId, parameters.configs.documentId);

            let bookDocument = {
                title: templateDocument.title.replace("template_", "book_"),
                abstract: templateDocument.abstract,
            }

            const documentId = await documentModule.addDocument(parameters.spaceId, bookDocument);
            apis.success(documentId);

            const retryAsync = async (fn, retries = 3, delay = 2000) => {
                for (let attempt = 1; attempt <= retries; attempt++) {
                    try {
                        return await fn();
                    } catch (error) {
                        if (attempt < retries) {
                            //console.warn(`Attempt ${attempt} failed. Retrying in ${delay}ms...`);
                            //await new Promise(resolve => setTimeout(resolve, delay));
                        } else {
                            console.error(`All ${retries} attempts failed for function ${fn.name}.`);
                            throw error;
                        }
                    }
                }
            };

            class TaskQueue {
                constructor(concurrency) {
                    this.concurrency = concurrency;
                    this.running = 0;
                    this.taskQueue = [];
                    this.resolveIdle = null;
                }

                pushTask(task) {
                    this.taskQueue.push(task);
                    this.next();
                }

                async next() {
                    if (this.running >= this.concurrency || this.taskQueue.length === 0) {
                        if (this.running === 0 && this.taskQueue.length === 0 && this.resolveIdle) {
                            this.resolveIdle();
                        }
                        return;
                    }
                    const task = this.taskQueue.shift();
                    this.running++;
                    try {
                        await task();
                    } catch (err) {
                        console.error('Task error:', err);
                    } finally {
                        this.running--;
                        this.next();
                    }
                }

                onIdle() {
                    return new Promise(resolve => {
                        if (this.running === 0 && this.taskQueue.length === 0) {
                            resolve();
                        } else {
                            this.resolveIdle = resolve;
                        }
                    });
                }
            }

            const taskQueue = new TaskQueue(6);

            apis.success(documentId);

            for (let chapterIndex = 0; chapterIndex < templateDocument.chapters.length; chapterIndex++) {
                const chapterData = {
                    title: templateDocument.chapters[chapterIndex].title,
                    idea: templateDocument.chapters[chapterIndex].idea,
                    paragraphs: []
                };
                const chapterId = await documentModule.addChapter(parameters.spaceId, documentId, chapterData);

                let paragraphIds = [];

                for (let index = 0; index < templateDocument.chapters[chapterIndex].paragraphs.length; index++) {
                    const paragraphId = await documentModule.addParagraph(parameters.spaceId, documentId, chapterId, {text: "Preparing for Generation..."});
                    await documentModule.updateParagraphComment(parameters.spaceId, documentId, paragraphId, templateDocument.chapters[chapterIndex].paragraphs[index].text);
                    paragraphIds.push(paragraphId);
                }
                for(let index=0; index<paragraphIds.length; index++) {
                    const task = async () => {
                        try {
                            const paragraphGenerationPrompt = createParagraphPrompt(
                               templateDocument.abstract,
                                chapterData,
                                templateDocument.chapters[chapterIndex].paragraphs[index].text
                            );
                            await documentModule.updateParagraphText(parameters.spaceId, documentId, paragraphIds[index], "Generating...with prompt: " + paragraphGenerationPrompt);
                            await applicationModule.runApplicationFlow(parameters.spaceId, "BooksGenerator", "ExpandParagraph", {
                                spaceId: parameters.spaceId,
                                prompt: paragraphGenerationPrompt,
                                bookData: templateDocument.abstract,
                                documentId: documentId,
                                chapterId: chapterId,
                                chapterTitle: templateDocument.chapters[chapterIndex].title,
                                chapterIdea: templateDocument.chapters[chapterIndex].idea,
                                paragraphPosition: index,
                                totalParagraphs: paragraphIds.length,
                                totalChapters: templateDocument.chapters.length,
                                chapterPosition: chapterIndex,
                                paragraphId: paragraphIds[index],
                                paragraphSchema: generateParagraphSchema
                            });
                        } catch (error) {
                            console.error(`Eroare la generarea paragrafului ${index + 1} din capitolul ${chapterIndex + 1}:`, error);
                        }
                    };
                    taskQueue.pushTask(() => retryAsync(task));
                }
            }
            await taskQueue.onIdle();
            applicationModule.runApplicationFlow(parameters.spaceId, "BooksGenerator", "RefineBook", {
                spaceId: parameters.spaceId,
                bookId: documentId,
            });

        } catch (e) {
            apis.fail(e);
        }
    }
}

module.exports = GenerateBook;
