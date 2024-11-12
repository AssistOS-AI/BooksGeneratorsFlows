const IFlow = require('assistos').loadModule('flow', {}).IFlow;

class RefineBook extends IFlow {
    static flowMetadata = {
        action: "Refine a Book",
        intent: "Refine a Book for Logical Flow"
    };

    static flowParametersSchema = {};

    constructor() {
        super();
    }

    async userCode(apis, parameters) {
        try {
            const llmModule = apis.loadModule('llm');
            const documentModule = apis.loadModule('document');
            const utilModule = apis.loadModule('util');

            const bookId = parameters.configs.bookId;
            const spaceId = parameters.configs.spaceId;
            const book = await documentModule.getDocument(spaceId, bookId);

            class TaskQueue {
                constructor(concurrency) {
                    this.concurrency = concurrency;
                    this.running = 0;
                    this.taskQueue = [];
                }

                pushTask(task) {
                    this.taskQueue.push(task);
                    this.next();
                }

                next() {
                    while (this.running < this.concurrency && this.taskQueue.length) {
                        const task = this.taskQueue.shift();
                        this.running++;
                        task().then(() => {
                            this.running--;
                            this.next();
                        }).catch((err) => {
                            console.error('Task failed:', err);
                            this.running--;
                            this.next();
                        });
                    }
                }
            }

            const concurrencyLimit = 3;
            const taskQueue = new TaskQueue(concurrencyLimit);

            const retryAsync = async (fn, retries = 3, delay = 2000) => {
                for (let attempt = 1; attempt <= retries; attempt++) {
                    try {
                        return await fn();
                    } catch (error) {
                        console.error(`Attempt ${attempt} failed with error: ${error.message}`);
                        if (attempt < retries) {
                            console.warn(`Retrying in ${delay}ms...`);
                            await new Promise(resolve => setTimeout(resolve, delay));
                        } else {
                            console.error(`All ${retries} attempts failed. Proceeding to next task.`);
                            return null;
                        }
                    }
                }
            };

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
                    "RemoveNewLine": async (jsonString) => jsonString.replace(/\n/g, ""),
                    "TrimSpaces": async (jsonString) => jsonString.trim(),
                    "LlmHelper": async (jsonString) => {
                        let prompt;
                        if (!jsonSchema) {
                            prompt = `Please convert the following string into a JSON string: "${jsonString}". Only respond with valid JSON.`;
                        } else {
                            prompt = `Please convert the following string into JSON: ${jsonString}. Match this schema: ${JSON.stringify(jsonSchema)}. Only respond with valid JSON without any code blocks or syntax markers.`;
                        }
                        const response = await llmModule.generateText({ prompt, modelName: "GPT-4o" }, spaceId);
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

            const paragraphSchema = { text: "String" };

            const Algorithms = {
                proceduralRefinement: async (book) => {
                    const generateAndSendRequest = async (prompt, paragraph, chapter, book) => {
                        const response = await retryAsync(async () => {
                            return await llmModule.generateText({
                                prompt,
                                modelName: "GPT-4o"
                            }, spaceId);
                        });

                        if (response) {
                            try {
                                let generatedParagraph = await ensureValidJson(response.messages[0], 2, paragraphSchema);
                                generatedParagraph = JSON.parse(generatedParagraph);
                                generatedParagraph.id = paragraph.id;
                                await documentModule.updateParagraph(spaceId, book.id, chapter.id, paragraph.id, generatedParagraph);
                            } catch (error) {
                                console.error(`Error processing response for paragraph ID: ${paragraph.id} in chapter ID: ${chapter.id}. Error: ${error.message}`);
                            }
                        } else {
                            console.warn(`Failed to refine paragraph ID: ${paragraph.id} in chapter ID: ${chapter.id}. Skipping this paragraph.`);
                        }
                    };

                    const treatFirstParagraph = async (currentParagraph, currentChapter, book) => {
                        const generateRefinementPrompt = () => {
                            return [
                                `You're a book content manager. Your purpose is to refactor the current paragraph to blend seamlessly with the flow and content of the book and the chapter.`,
                                `Current paragraph: ${currentParagraph.text}`,
                                `Chapter: {title: "${currentChapter.title}", idea: "${currentChapter.idea}"}`,
                                `Book abstract: ${book.abstract}`,
                                `Your response should be a JSON string matching the structure: ${JSON.stringify(paragraphSchema)}. Do not include any code blocks or syntax markers.`
                            ].join("\n");
                        };
                        await generateAndSendRequest(generateRefinementPrompt(), currentParagraph, currentChapter, book);
                    };

                    const treatLastParagraph = async (currentParagraph, previousParagraph, currentChapter, book) => {
                        const generateRefinementPrompt = () => {
                            return [
                                `You're a book content manager. Your purpose is to refactor the current paragraph to blend seamlessly with the flow and content of the book and the chapter.`,
                                `Current paragraph: ${currentParagraph.text}`,
                                `Previous paragraph: ${previousParagraph.text}`,
                                `Chapter: {title: "${currentChapter.title}", idea: "${currentChapter.idea}"}`,
                                `Book abstract: ${book.abstract}`,
                                `Your response should be a JSON string matching the structure: ${JSON.stringify(paragraphSchema)}. Do not include any code blocks or syntax markers.`
                            ].join("\n");
                        };
                        await generateAndSendRequest(generateRefinementPrompt(), currentParagraph, currentChapter, book);
                    };

                    const treatMiddleParagraph = async (currentParagraph, previousParagraph, nextParagraph, currentChapter, book) => {
                        const generateRefinementPrompt = () => {
                            return [
                                `You're a book content manager. Your purpose is to refactor the current paragraph to blend seamlessly with the flow and content of the book and the chapter.`,
                                `Current paragraph: ${currentParagraph.text}`,
                                `Previous paragraph: ${previousParagraph.text}`,
                                `Next paragraph: ${nextParagraph.text}`,
                                `Chapter: {title: "${currentChapter.title}", idea: "${currentChapter.idea}"}`,
                                `Book abstract: ${book.abstract}`,
                                `Your response should be a JSON string matching the structure: ${JSON.stringify(paragraphSchema)}. Do not include any code blocks or syntax markers.`
                            ].join("\n");
                        };
                        await generateAndSendRequest(generateRefinementPrompt(), currentParagraph, currentChapter, book);
                    };

                    const chapters = book.chapters;
                    book.abstract = utilModule.unsanitize(book.abstract);


                    for (const [chapterIndex, chapter] of chapters.entries()) {
                        taskQueue.pushTask(async () => {
                            console.info(`Începem rafinarea pentru Capitolul ${chapterIndex + 1}/${chapters.length}`);

                            for (const [paragraphIndex, paragraph] of chapter.paragraphs.entries()) {
                                console.info(`Refinăm Paragraful ${paragraphIndex + 1}/${chapter.paragraphs.length} din Capitolul ${chapterIndex + 1}`);

                                if (chapter.paragraphs.length === 1) {
                                    await treatFirstParagraph(paragraph, chapter, book);
                                } else if (paragraphIndex === 0) {
                                    await treatFirstParagraph(paragraph, chapter, book);
                                } else if (paragraphIndex === chapter.paragraphs.length - 1) {
                                    await treatLastParagraph(paragraph, chapter.paragraphs[paragraphIndex - 1], chapter, book);
                                } else {
                                    await treatMiddleParagraph(
                                        paragraph,
                                        chapter.paragraphs[paragraphIndex - 1],
                                        chapter.paragraphs[paragraphIndex + 1],
                                        chapter,
                                        book
                                    );
                                }

                                console.info(`Finalizat rafinarea Paragrafului ${paragraphIndex + 1}/${chapter.paragraphs.length} din Capitolul ${chapterIndex + 1}`);
                            }

                            console.info(`Finalizat rafinarea pentru Capitolul ${chapterIndex + 1}/${chapters.length}`);
                        });
                    }

                    await new Promise(resolve => {
                        const checkCompletion = () => {
                            if (taskQueue.running === 0 && taskQueue.taskQueue.length === 0) {
                                resolve();
                            } else {
                                setTimeout(checkCompletion, 500);
                            }
                        };
                        checkCompletion();
                    });
                }
            };

            await Algorithms.proceduralRefinement(book);

            apis.success('Book refinement completed successfully.');
        } catch (error) {
            console.error('Error in RefineBook userCode:', error);
            apis.fail(error);
        }
    }
}

module.exports = RefineBook;
