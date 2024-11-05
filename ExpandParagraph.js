const IFlow = require('assistos').loadModule('flow', {}).IFlow;

class ExpandParagraph extends IFlow {
    static flowMetadata = {
        action: "Expand a Paragraph",
        intent: "Expand a Paragraph"
    };

    static flowParametersSchema = {};

    constructor() {
        super();
    }

    async userCode(apis, parameters) {
        const llmModule = apis.loadModule("llm");
        const documentModule = apis.loadModule("document");
        const {spaceId,documentId,chapterId,paragraphId,prompt,bookData,chapterTitle,ChapterIdea,paragraphSchema} = parameters.configs;
        apis.success(); // return immediately to avoid request timeout
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


            let response = await llmModule.sendLLMRequest({
                prompt: prompt,
                modelName: "o1-preview"
            }, parameters.spaceId);


            let paragraphJsonString;

            try {
                paragraphJsonString = await ensureValidJson(response.messages[0], 1,paragraphSchema);
            } catch (error) {
                response = await llmModule.sendLLMRequest({
                    prompt: prompt,
                    modelName: "o1-preview"
                }, parameters.spaceId);
                paragraphJsonString = await ensureValidJson(response.messages[0], 2);
            }

            const paragraphGenerated = JSON.parse(paragraphJsonString);

            paragraphGenerated.id = paragraphId;

            await documentModule.updateParagraph(spaceId, documentId, paragraphId, paragraphGenerated);
            return paragraphGenerated;

        } catch (e) {
            await documentModule.updateParagraph(spaceId, documentId, paragraphId, {"text":`Error in expanding paragraph:${e.message}`,id:paragraphId});
            apis.fail(e);
        }
    }
}

module.exports = ExpandParagraph;