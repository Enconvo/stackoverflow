// Usage
import { uuid as uuidv4, Action, ActionProps, ServiceProvider, ChatHistory, Clipboard, res, CoreDataChatHistory, LLMUtil, LinkReaderProviderBase, LLMProviderBase, language } from "@enconvo/api";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { BrowsingItem, BrowsingProviderBase } from "./browsing_provider.ts";
import { HumanMessage } from "langchain/schema";

const chatHistory = new CoreDataChatHistory()
let LANGUAGE = "english"

export default async function main(req: Request) {
    const { options } = await req.json()
    const { text, context, reset } = options

    let query = text || context || options.stream !== true && await Clipboard.selectedText();

    const requestId = uuidv4()
    const resultID = uuidv4()
    // 如果translateText中有换行符，需要添加> 符号
    if (!query) {
        throw new Error("No text to search for. Please provide a text to search for.")
    }

    const displayText = (query).replace(/\n/g, "\n> ");
    await res.context({ id: requestId, role: "human", content: `\n\n> ${displayText}\n\n` })


    await res.write({
        content: {
            id: resultID,
            role: "ai",
            content: [
                {
                    type: 'text',
                    text: "Browsing the internet...",
                }
            ]
        },
        overwrite: true
    })

    const model: LLMProviderBase = ServiceProvider.load(options.llm);

    reset && chatHistory.reset();
    const historyMessages = await chatHistory.getMessages()
    if (historyMessages.length > 0) {
        const query_prompt = `Based on the previous conversation, as a Google search engine, your task is to generate a new search query in the same language Please create a new search query based on the previous conversation. Your search query should be relevant to the previous topic and demonstrate an understanding of the context and user's preferences.

Input :${query}
            `

        const newModel: LLMProviderBase = ServiceProvider.load(options.llm);
        const stream = (await newModel.call({ messages: [...historyMessages, ...[new HumanMessage(query_prompt)]] })).stream!
        const queryResult = await LLMUtil.invokeLLM(stream)

        query = queryResult as string
    } else {
        if (options.responseLanguage?.value === "auto") {
            LANGUAGE = await language.detect(query)
        } else {
            LANGUAGE = options.responseLanguage?.title
        }

    }

    console.log("language", LANGUAGE, options.responseLanguage)


    const browsingProvider: BrowsingProviderBase = ServiceProvider.load(options.browsing_providers)

    const searchResult = await browsingProvider.call({ query, includeSites:options.includeSites })

    if (!searchResult) {
        throw new Error("No search result found")
    }
    const items = searchResult.items.map(item => {
        // get the host from the url
        const url = new URL(item.url)
        const host = url.host
        return {
            title: item.title,
            user: host,
            url: item.url,
            icon: `https://www.google.com/s2/favicons?domain=${item.url}&sz=${128}`
        }
    })


    const resultMessage = {
        type: 'search_result_list',
        items
    }

    await res.write({
        content: {
            id: resultID,
            role: "ai",
            content: [
                {
                    type: 'text',
                    text: "Analyze the search results...",
                },
                //@ts-ignore
                resultMessage
            ]
        },
        overwrite: true
    })

    const questionAnsweringPrompt = ChatPromptTemplate.fromMessages([
        [
            "human",
            `Answer the following  input questions as best you can. Use the sources to provide an accurate response. Respond in markdown format. Provide an accurate response and then stop. Today's date is ${new Date().toLocaleDateString()}.

Example Input:
What's the weather in San Francisco today?

Example Response:
It's 70 degrees and sunny in San Francisco today. 


Input:
{input}

Sources:
{sources}

Language:
Answer the question using Language: {LANGUAGE}

Response:
                `,
        ]
    ]);



    const scraper: LinkReaderProviderBase = ServiceProvider.load(options.link_reader_providers)
    const promiseItems = searchResult.items.map((result, index) => {
        return new Promise<BrowsingItem>(async (resolve, reject) => {
            let content = result.content;
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    console.log("timeout", result.url)
                    resolve({
                        title: result.title,
                        url: result.url,
                        content: result.snippet,
                        snippet: result.snippet
                    })
                }, 5000); // 2 seconds timeout
            });
            try {
                if (index === 0 || index === 1 || index === 3) {
                    const scrapContent = await Promise.race([
                        scraper.call(result.url),
                        timeoutPromise
                    ]);
                    // console.log("scrapContent", scrapContent)
                    if (scrapContent && scrapContent.raw) {
                        content = scrapContent.raw;
                    }
                }
                resolve({
                    title: result.title,
                    url: result.url,
                    content: content,
                    snippet: result.snippet
                });
            } catch (error) {
                reject(error);
            }
        });
    });
    const searchItems = await Promise.all(promiseItems)

    const messages = await questionAnsweringPrompt.formatMessages({
        LANGUAGE: LANGUAGE, input: query, sources: JSON.stringify(searchItems)
    });


    const stream = (await model.call({ messages: [...historyMessages, ...messages] })).stream!

    const result = await LLMUtil.invokeLLMStream(stream, options, resultMessage)

    await ChatHistory.saveChatMessages({
        input: query,
        output: result,
        requestId,
        messages,
        llmOptions: options.llm
    });


    const actions: ActionProps[] = [
        Action.Paste({ content: result }),
        Action.Copy({ content: result }),
        Action.PlayAudio({
            content: result
        }),
        Action.PauseResumeAudio(),
    ]

    const output = {
        type: "messages",
        messages: [
            {
                id: resultID,
                role: "ai",
                content: [
                    {
                        type: 'text',
                        text: result
                    },
                    resultMessage
                ]
            }
        ],
        actions: actions
    }


    return output;
}
