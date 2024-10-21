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
            let documentModule = apis.loadModule("document");
            apis.success("Template generated successfully");
        } catch (e) {
            apis.fail(e);
        }
    }
}

module.exports = GenerateTemplate;
