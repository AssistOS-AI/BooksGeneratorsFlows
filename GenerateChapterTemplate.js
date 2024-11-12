const IFlow = require('assistos').loadModule('flow', {}).IFlow;

class GenerateChapterTemplate extends IFlow {
    static flowMetadata = {
        action: "Generate a Chapter Template",
        intent: "Generates a Chapter Template"
    };

    static flowParametersSchema = {};

    constructor() {
        super();
    }

    async userCode(apis, parameters) {
        this.rollback = async (e) => {
            for (let index = 0; index < this.paragraphIds?.length; index++) {
                await documentModule.deleteParagraph(parameters.spaceId, documentId, chapterId, this.paragraphIds[index]);
            }
            console.info(`-------------------------Rollback Chapter ${chapterPosition}-------------------------`);
            apis.error(e+"LOG:chapterId:"+chapterId);
        }
        const llmModule = apis.loadModule("llm");
        const documentModule = apis.loadModule("document");

        const prompt = parameters.configs.prompt;
        const spaceId = parameters.configs.spaceId;
        const documentId = parameters.configs.documentId;
        const chapterId = parameters.configs.chapterId;
        const chapterTitle = parameters.configs.chapterTitle;
        const chapterIdea = parameters.configs.chapterIdea;
        const chapterPosition = parameters.configs.chapterPosition;

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
                        let prompt;
                        if (!jsonSchema) {
                            prompt = `Please convert the following string into a json:${jsonString}.
                             Only respond with a valid Json that doesn't contain any code blocks or the \`\`\`json syntax.`;
                        } else {
                            prompt = `Please convert the following string into a json:${jsonString}.
                             Only respond with a valid Json that doesn't contain any code blocks or the \`\`\`json syntax.
                             Your response should match this json schema: ${JSON.stringify(jsonSchema)}`;
                        }
                        const response = await llmModule.generateText({
                            prompt,
                            modelName: "Qwen"
                        }, parameters.spaceId);
                        return response.messages?.[0] || response;
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

            let llmResponse = await llmModule.generateText({
                prompt,
                modelName: "Qwen"
            }, parameters.spaceId);
            llmResponse=llmResponse.messages?.[0] || llmResponse;
            const paragraphsJsonString = await ensureValidJson(llmResponse, 5);
            const paragraphsData = JSON.parse(paragraphsJsonString);
            this.paragraphIds = [];
            for (let contor = 0; contor < paragraphsData.paragraphs.length; contor++) {
                const paragraphObj = {
                    text: paragraphsData.paragraphs[contor].idea,
                };
                this.paragraphIds.push(await documentModule.addParagraph(parameters.spaceId, documentId, chapterId, paragraphObj));
                console.info(`Chapter:${chapterPosition}-----------------------Finished Paragraph ${contor + 1}/${paragraphsData.paragraphs.length}-------------------------`);
            }
            console.info(`-------------------------Finished Chapter ${chapterPosition}-------------------------`);
            apis.success(chapterId);
        } catch (e) {
            await this.rollback(e);
        }
    }
}

module.exports = GenerateChapterTemplate;
