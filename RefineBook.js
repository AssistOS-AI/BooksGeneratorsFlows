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
        const bookId = parameters.configs.bookId;
        const spaceId = parameters.configs.spaceId;
        try {
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
                            prompt = `Please convert the following string into JSON format matching the following schema:
${JSON.stringify(jsonSchema, null, 2)}
Only respond with valid JSON without any code blocks or syntax markers.`;
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

            const Algorithms = {
                // Rafinare de context intre chunk-uri de paragrafe -> Asigura coerenta si fluiditate intre paragrafe
                proceduralRefinement: async (book) => {
                    const generateAndSendRequest = async (prompt, paragraph, chapter, book) => {
                        let response = await retryAsync(async () => {
                            return await llmModule.generateText(spaceId, prompt, parameters.personality);
                        });
                        response = response.message
                        if (response) {
                            try {
                                let generatedParagraph = await ensureValidJson(response, 3, paragraphSchema);
                                generatedParagraph = JSON.parse(generatedParagraph);
                                await documentModule.updateParagraphText(spaceId, book.id, paragraph.id, generatedParagraph.text);
                                paragraph.text = generatedParagraph.text; //update the local paragraph object
                            } catch (error) {
                                await documentModule.updateParagraphText(spaceId, book.id,  paragraph.id, "Error refining paragraph: " + error.message);
                                console.error(`Error processing response for paragraph ID: ${paragraph.id} in chapter ID: ${chapter.id}. Error: ${error.message}`);
                            }
                        } else {
                            console.warn(`Failed to refine paragraph ID: ${paragraph.id} in chapter ID: ${chapter.id}. Skipping this paragraph.`);
                        }
                    };

                    const treatFirstParagraph = async (currentParagraph, currentChapter, book) => {
                        const generateRefinementPrompt = () => {
                            return `
                    You are a book content manager. Your task is to refactor the current paragraph to blend seamlessly with the flow and content of the book and the chapter.
                    
                    **Instructions**:
                    - Output your response **only** in JSON format matching the following schema:
                    ${JSON.stringify(paragraphSchema, null, 2)}
                    - **Do not** include any text outside of the JSON output.
                    - Ensure the paragraph connects logically with the chapter and book content.
                    
                    **Book Abstract**:
                    "${book.abstract}"
                    
                    **Chapter Details**:
                    {
                      "title": "${currentChapter.title}",
                      "idea": "${currentChapter.idea}"
                    }
                    
                    **Current Paragraph**:
                    "${currentParagraph.text}"
                    
                    Please generate the refined paragraph in JSON format now.`;
                        };
                        await generateAndSendRequest(generateRefinementPrompt(), currentParagraph, currentChapter, book);
                    };

                    const treatLastParagraph = async (currentParagraph, previousParagraph, currentChapter, book) => {
                        const generateRefinementPrompt = () => {
                            return `
                    You are a book content manager. Your task is to refactor the current paragraph to blend seamlessly with the flow and content of the book and the chapter.
                    
                    **Instructions**:
                    - Output your response **only** in JSON format matching the following schema:
                    ${JSON.stringify(paragraphSchema, null, 2)}
                    - **Do not** include any text outside of the JSON output.
                    - Ensure the paragraph connects logically with the chapter and book content.
                    
                    **Book Abstract**:
                    "${book.abstract}"
                    
                    **Chapter Details**:
                    {
                      "title": "${currentChapter.title}",
                      "idea": "${currentChapter.idea}"
                    }
                    
                    **Previous Paragraph**:
                    "${previousParagraph.text}"
                    
                    **Current Paragraph**:
                    "${currentParagraph.text}"
                    
                    Please generate the refined paragraph in JSON format now.`;
                        };
                        await generateAndSendRequest(generateRefinementPrompt(), currentParagraph, currentChapter, book);
                    };

                    const treatMiddleParagraph = async (currentParagraph, previousParagraph, nextParagraph, currentChapter, book) => {
                        const generateRefinementPrompt = () => {
                            return `
                    You are a book content manager. Your task is to refactor the current paragraph to blend seamlessly with the flow and content of the book and the chapter.
                    
                    **Instructions**:
                    - Output your response **only** in JSON format matching the following schema:
                    ${JSON.stringify(paragraphSchema, null, 2)}
                    - **Do not** include any text outside of the JSON output.
                    - Ensure the paragraph connects logically with the surrounding paragraphs, chapter, and book content.
                    
                    **Book Abstract**:
                    "${book.abstract}"
                    
                    **Chapter Details**:
                    {
                      "title": "${currentChapter.title}",
                      "idea": "${currentChapter.idea}"
                    }
                    
                    **Previous Paragraph**:
                    "${previousParagraph.text}"
                    
                    **Current Paragraph**:
                    "${currentParagraph.text}"
                    
                    **Next Paragraph**:
                    "${nextParagraph.text}"
                    
                    Please generate the refined paragraph in JSON format now.`;
                        };
                        await generateAndSendRequest(generateRefinementPrompt(), currentParagraph, currentChapter, book);
                    };

                    const chapters = book.chapters;
                    book.abstract = utilModule.unsanitize(book.abstract);

                    for (const [chapterIndex, chapter] of chapters.entries()) {
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

                    }
                },
                // Rafinare de tranzitie intre paragrafe
                transitionEnhancer: async (book) => {
                    const generateAndSendRequest = async (prompt, paragraph, previousParagraph, chapter) => {
                        let response = await retryAsync(async () => {
                            return await llmModule.generateText(spaceId, prompt, parameters.personality);
                        });
                        response = response.message
                        if (response) {
                            try {
                                let generatedParagraph = await ensureValidJson(response, 3, paragraphSchema);
                                generatedParagraph = JSON.parse(generatedParagraph);
                                await documentModule.updateParagraphText(spaceId, book.id,  paragraph.id, generatedParagraph.text);
                                paragraph.text = generatedParagraph.text;
                            } catch (error) {
                                await documentModule.updateParagraphText(spaceId, book.id,  paragraph.id, "Err");
                                console.error(`Error processing response for paragraph ID: ${paragraph.id} in chapter ID: ${chapter.id}. Error: ${error.message}`);
                            }
                        } else {
                            console.warn(`Failed to refine paragraph ID: ${paragraph.id} in chapter ID: ${chapter.id}. Skipping this paragraph.`);
                        }
                    };

                    for (const chapter of book.chapters) {
                        for (let i = 0; i < chapter.paragraphs.length; i++) {
                            const paragraph = chapter.paragraphs[i];
                            const previousParagraph = i > 0 ? chapter.paragraphs[i - 1] : null;

                            const prompt = `
                            You are an editor improving transitions between paragraphs.
                        
                            **Instructions**:
                            - If applicable, adjust the beginning of the current paragraph to connect smoothly with the previous paragraph.
                            - Ensure logical progression and coherent flow.
                            - Output your response **only** in JSON format matching the following schema:
                            ${JSON.stringify(paragraphSchema, null, 2)}
                            - **Do not** include any text outside of the JSON output.
                        
                            ${previousParagraph ? `**Previous Paragraph**:\n"${previousParagraph.text}"` : ''}
                            **Current Paragraph**:
                            "${paragraph.text}"
                        
                            Please provide the refined paragraph in JSON format now.`;

                            await generateAndSendRequest(prompt, paragraph, previousParagraph, chapter);
                        }
                    }
                },
                // Rafinare/Corectare de stil dupa personalitatea selectata -> Mentinere unui stil consistent sau pentru a adapta textul la un anumit ton/voce narativa
                styleCorrection: async (book) => {},
                // Extindere paragrafe curente -> Imbogatire continut unde este necesar
                deepParagraphExpansion: async (book) => {},
                // Adaugare de noi paragrafe in capitole -> acoperirea mai multor sub-teme in capitole
                deepChapterExpansion: async (book) => {},
                // Adaugare de noi capitole in carte -> introduce noi teme si subiecte
                deepBookExpansion: async (book) => {}
            };

            const llmModule = await apis.loadModule('llm');
            const documentModule = await apis.loadModule('document');
            const utilModule = await apis.loadModule('util');

            const book = await documentModule.getDocument(spaceId, bookId);
            const modelName = "Qwen";

            const paragraphSchema = {"text": "String"};

            await Algorithms.proceduralRefinement(book);
            await Algorithms.transitionEnhancer(book);
            await Algorithms.styleCorrection(book);
            await Algorithms.deepParagraphExpansion(book);
            await Algorithms.deepChapterExpansion(book);
            await Algorithms.deepBookExpansion(book);

            apis.success(book);
        } catch (error) {
            apis.fail(error.message);
        }
    }
}

module.exports = RefineBook;
