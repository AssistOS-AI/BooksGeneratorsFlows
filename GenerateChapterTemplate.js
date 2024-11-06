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
        const llmModule = apis.loadModule("llm");
        const documentModule = apis.loadModule("document");

        const prompt = parameters.configs.prompt;
        const spaceId = parameters.configs.spaceId;
        const documentId = parameters.configs.documentId;
        const chapterTitle = parameters.configs.chapterTitle;
        const chapterIdea = parameters.configs.chapterIdea;

        const chapterId = await documentModule.addChapter(spaceId, parameters.configs.documentId, {
            idea: chapterIdea,
            title: chapterTitle
        });

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

            const llmResponse = await llmModule.sendLLMRequest({
                prompt,
                modelName: "o1-mini"
            }, parameters.spaceId);

            const paragraphsJsonString = await ensureValidJson(llmResponse.messages[0], 5);
            const paragraphsData = JSON.parse(paragraphsJsonString);
            for (const paragraph of paragraphsData.paragraphs) {
                const paragraphObj = {
                    text: paragraph.idea,
                };
                await documentModule.addParagraph(parameters.spaceId, documentId, chapterId, paragraphObj);
            }
            apis.success(chapterId);
        } catch (e) {
            await documentModule.addParagraph(parameters.spaceId, documentId, chapterId, {text: "Failed to generate chapter template"});
            apis.fail(e);
        }
    }
}

module.exports = GenerateChapterTemplate;
