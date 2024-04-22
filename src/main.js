//@ts-check

var lang = require("./lang.js");
var SYSTEM_PROMPT = require("./const.js").SYSTEM_PROMPT;

var {
    buildHeader,
    ensureHttpsAndNoTrailingSlash,
    getApiKey,
    handleGeneralError,
    handleValidateError,
    replacePromptKeywords
} = require("./utils.js");


/**
 * @param {Bob.TranslateQuery} query 查询参数
 * @returns {{ 
 *  generatedSystemPrompt: string, 
 *  generatedUserPrompt: string 
 * }} 返回包含系统提示语和用户提示语的对象
*/
function generatePrompts(query) {
    let generatedSystemPrompt = SYSTEM_PROMPT;
    const { detectFrom, detectTo } = query;
    const sourceLang = lang.langMap.get(detectFrom) || detectFrom;
    const targetLang = lang.langMap.get(detectTo) || detectTo;
    let generatedUserPrompt = `translate from ${sourceLang} to ${targetLang}`;

    if (detectTo === "wyw" || detectTo === "yue") {
        generatedUserPrompt = `翻译成${targetLang}`;
    }

    if (
        detectFrom === "wyw" ||
        detectFrom === "zh-Hans" ||
        detectFrom === "zh-Hant"
    ) {
        if (detectTo === "zh-Hant") {
            generatedUserPrompt = "翻译成繁体白话文";
        } else if (detectTo === "zh-Hans") {
            generatedUserPrompt = "翻译成简体白话文";
        } else if (detectTo === "yue") {
            generatedUserPrompt = "翻译成粤语白话文";
        }
    }
    if (detectFrom === detectTo) {
        generatedSystemPrompt =
            "You are a text embellisher, you can only embellish the text, don't interpret it.";
        if (detectTo === "zh-Hant" || detectTo === "zh-Hans") {
            generatedUserPrompt = "润色此句";
        } else {
            generatedUserPrompt = "polish this sentence";
        }
    }

    generatedUserPrompt = `${generatedUserPrompt}:\n\n${query.text}`

    return { generatedSystemPrompt, generatedUserPrompt };
}

/**
 * @param {string} model 模型名称
 * @param {Bob.TranslateQuery} query 查询参数
 * @returns {{ 
 *  model: string;
 *  messages?: {
 *    role: "system" | "user";
 *    content: string;
 *  }[];
 *  prompt?: string;
 * }} 返回构建好的请求体
*/
function buildRequestBody(model, query) {
    let { customSystemPrompt, customUserPrompt } = $option;
    const { generatedSystemPrompt, generatedUserPrompt } = generatePrompts(query);

    customSystemPrompt = replacePromptKeywords(customSystemPrompt, query);
    customUserPrompt = replacePromptKeywords(customUserPrompt, query);

    const systemPrompt = customSystemPrompt || generatedSystemPrompt;
    const userPrompt = customUserPrompt || generatedUserPrompt;

    const standardBody = {
        model: model,
    };

    return {
        ...standardBody,
        model: model,
        messages: [
            {
                role: "system",
                content: systemPrompt,
            },
            {
                role: "user",
                content: userPrompt,
            },
        ],
    };
}

/** 
 * @param {Bob.TranslateQuery} query 查询对象
 * @param {string} targetText 目标文本
 * @param {string} textFromResponse 响应文本
 * @returns {string} 返回处理后的文本
*/
function handleStreamResponse(query, targetText, textFromResponse) {
    if (textFromResponse !== '[DONE]') {
        try {
            const dataObj = JSON.parse(textFromResponse);
            const { choices } = dataObj;
            const delta = choices[0]?.delta?.content;
            if (delta) {
                targetText += delta;
                query.onStream({
                    result: {
                        from: query.detectFrom,
                        to: query.detectTo,
                        toParagraphs: [targetText],
                    },
                });
            }
        } catch (err) {
            handleGeneralError(query, {
                type: err.type || "param",
                message: err.message || "Failed to parse JSON",
                addition: err.addition,
            });
        }
    }
    return targetText;
}

/**
 * @param {Bob.TranslateQuery} query
 * @param {Bob.HttpResponse} result
 * @returns {void}
 * 处理通用响应
 * @param query 查询对象
 * @param result 查询结果
*/
function handleGeneralResponse(query, result) {
    const { choices } = result.data;

    if (!choices || choices.length === 0) {
        handleGeneralError(query, {
            type: "api",
            message: "接口未返回结果",
            addition: JSON.stringify(result),
        });
        return;
    }

    let targetText = choices[0].message.content.trim();

    // 使用正则表达式删除字符串开头和结尾的特殊字符
    targetText = targetText.replace(/^(『|「|"|“)|(』|」|"|”)$/g, "");

    // 判断并删除字符串末尾的 `" =>`
    if (targetText.endsWith('" =>')) {
        targetText = targetText.slice(0, -4);
    }

    query.onCompletion({
        result: {
            from: query.detectFrom,
            to: query.detectTo,
            toParagraphs: targetText.split("\n"),
        },
    });
}

/**
 * @type {Bob.Translate}
 * 翻译函数
 * @param query 翻译请求对象
 */
function translate(query) {
    if (!lang.langMap.get(query.detectTo)) {
        handleGeneralError(query, {
            type: "unsupportLanguage",
            message: "不支持该语种",
            addition: "不支持该语种",
        });
    }

    const {
        apiKeys,
        apiUrl,
        customModel,
        model,
        stream,
    } = $option;

    const isCustomModelRequired = model === "custom";
    if (isCustomModelRequired && !customModel) {
        handleGeneralError(query, {
            type: "param",
            message: "配置错误 - 请确保您在插件配置中填入了正确的自定义模型名称",
            addition: "请在插件配置中填写自定义模型名称",
        });
    }

    if (!apiKeys) {
        handleGeneralError(query, {
            type: "secretKey",
            message: "配置错误 - 请确保您在插件配置中填入了正确的 API Keys",
            addition: "请在插件配置中填写 API Keys",
        });
    }

    const modelValue = isCustomModelRequired ? customModel : model;

    const apiKey = getApiKey($option.apiKeys);

    const baseUrl = ensureHttpsAndNoTrailingSlash(apiUrl || "https://open.bigmodel.cn");
    let apiUrlPath;
    if (baseUrl.includes("open.bigmodel.cn") || baseUrl.includes("gateway.ai.cloudflare.com")) {
        apiUrlPath = "/api/paas/v4/chat/completions";
    } else {
        apiUrlPath = "/v1/chat/completions";
    }

    const isChatGLMServiceProvider = baseUrl.includes("open.bigmodel.cn") || baseUrl.includes("gateway.ai.cloudflare.com");

    const header = buildHeader(isChatGLMServiceProvider, apiKey);
    const body = buildRequestBody(modelValue, query);

    let targetText = ""; // 初始化拼接结果变量
    let buffer = ""; // 新增 buffer 变量
    (async () => {
        if (stream) {
            await $http.streamRequest({
                method: "POST",
                url: baseUrl + apiUrlPath,
                header,
                body: {
                    ...body,
                    stream: true,
                },
                cancelSignal: query.cancelSignal,
                streamHandler: (streamData) => {
                    if (streamData.text?.includes("Invalid token")) {
                        handleGeneralError(query, {
                            type: "secretKey",
                            message: "配置错误 - 请确保您在插件配置中填入了正确的 API Keys",
                            addition: "请在插件配置中填写正确的 API Keys",
                            troubleshootingLink: "https://zhipu-ai.feishu.cn/wiki/VdWrwLQLSicQxekqlvJcVhPQnze"
                        });
                    } else if (streamData.text !== undefined) {
                        // 将新的数据添加到缓冲变量中
                        buffer += streamData.text;
                        // 检查缓冲变量是否包含一个完整的消息
                        while (true) {
                            const match = buffer.match(/data: (.*?})\n/);
                            if (match) {
                                // 如果是一个完整的消息，处理它并从缓冲变量中移除
                                const textFromResponse = match[1].trim();
                                targetText = handleStreamResponse(query, targetText, textFromResponse);
                                buffer = buffer.slice(match[0].length);
                            } else {
                                // 如果没有完整的消息，等待更多的数据
                                break;
                            }
                        }
                    }
                },
                handler: (result) => {
                    if (result.response.statusCode >= 400) {
                        handleGeneralError(query, result);
                    } else {
                        query.onCompletion({
                            result: {
                                from: query.detectFrom,
                                to: query.detectTo,
                                toParagraphs: [targetText],
                            },
                        });
                    }
                }
            });
        } else {
            const result = await $http.request({
                method: "POST",
                url: baseUrl + apiUrlPath,
                header,
                body,
            });

            if (result.error) {
                handleGeneralError(query, result);
            } else {
                handleGeneralResponse(query, result);
            }
        }
    })().catch((err) => {
        handleGeneralError(query, err);
    });
}

/**
 * 获取支持的语言列表
 *
 * @returns 返回一个包含支持语言名称的数组
 */
function supportLanguages() {
    return lang.supportLanguages.map(([standardLang]) => standardLang);
}


/**
 * @type {Bob.PluginValidate}
 * 插件验证函数
 * 验证完成后的回调函数
 */
function pluginValidate(completion) {
    const { apiKeys, apiUrl } = $option;
    if (!apiKeys) {
        handleValidateError(completion, {
            type: "secretKey",
            message: "配置错误 - 请确保您在插件配置中填入了正确的 API Keys",
            addition: "请在插件配置中填写正确的 API Keys",
            troubleshootingLink: "https://zhipu-ai.feishu.cn/wiki/VdWrwLQLSicQxekqlvJcVhPQnze"
        });
        return;
    }

    const apiKey = getApiKey(apiKeys);

    const baseUrl = ensureHttpsAndNoTrailingSlash(apiUrl || "https://open.bigmodel.cn");
    let apiUrlPath;
    if (baseUrl.includes("open.bigmodel.cn") || baseUrl.includes("gateway.ai.cloudflare.com")) {
        apiUrlPath = "/api/paas/v4/chat/completions";
    } else {
        apiUrlPath = "/v1/chat/completions";
    }
    const isChatGLMServiceProvider = baseUrl.includes("open.bigmodel.cn") || baseUrl.includes("gateway.ai.cloudflare.com");

    const header = buildHeader(isChatGLMServiceProvider, apiKey);
    const body = {
        "stream": true,
        "model": "glm-4",
        "messages": [{
            "content": "You are a helpful assistant.",
            "role": "system",
        }, {
            "content": "Test connection.",
            "role": "user",
        }],
    };
    (async () => {
        if (isChatGLMServiceProvider) {
            $http.request({
                method: "POST",
                url: baseUrl + apiUrlPath,
                header: header,
                body: body,
                handler: function (resp) {
                    // $log.info("========: ");
                    if (resp.data.error) {
                        const { statusCode } = resp.response;
                        const reason = (statusCode >= 400 && statusCode < 500) ? "param" : "api";
                        handleValidateError(completion, {
                            type: reason,
                            message: resp.data.error,
                            troubleshootingLink: "https://open.bigmodel.cn/dev/howuse/faq"
                        });
                        return;
                    }
                    if (resp.data.choices.length > 0) {
                        completion({
                            result: true,
                        })
                    }
                }
            });
        } else {
            $http.request({
                method: "POST",
                url: baseUrl + apiUrlPath,
                header: header,
                body: body,
                handler: function (resp) {
                    if (resp.data.data === null) {
                        // 定义错误消息对象
                        const errorMessages = {
                            '-9999': 'API异常错误',
                            '-2000': '请求参数非法',
                            '-2001': '请求失败',
                            '-2002': 'Token已失效',
                            '-2003': '远程文件URL非法',
                            '-2004': '远程文件超出大小',
                            '-2005': '已有对话流正在输出',
                            '-2006': '内容由于合规问题已被阻止生成',
                            '-2007': '图像生成失败',
                            '-1000': '系统异常',
                            '-1001': '请求参数校验错误',
                            '-1002': '无匹配的路由'
                        };
                        const {statusCode} = resp.response;
                        const reason = Object.keys(errorMessages).includes(statusCode.toString()) ? errorMessages[statusCode] : '参数错误，请检查参数。';
                        handleValidateError(completion, {
                            type: reason,
                            message: resp.data.message,
                            troubleshootingLink: "https://open.bigmodel.cn/dev/howuse/faq"
                        });
                        return;
                    };
                    completion({ result: true });
                }
            });
        }
    })().catch((err) => {
        handleValidateError(completion, err);
    });
}
// function pluginTimeoutInterval() {
//     return 60;
// }

// exports.pluginTimeoutInterval = pluginTimeoutInterval;
exports.pluginValidate = pluginValidate;
exports.supportLanguages = supportLanguages;
exports.translate = translate;