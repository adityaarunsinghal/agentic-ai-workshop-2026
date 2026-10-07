## Dinner for two

Lalima’s restaurant has eight tables and an open kitchen. **Lalima** is a skilled, inventive chef. She can turn a cabbage into dumplings, a roast, a salad or a slow braise. She can explain a dish to a beginner, give Tim detailed cooking instructions or adapt a recipe to what is left in the fridge. She once helped a regular recreate his grandmother’s soup, asking questions and adjusting the recipe over several visits.

> **LLM: large language model.** Lalima’s cooking knowledge represents capabilities learned during training. An LLM draws on patterns across many subjects to explain, translate, plan and combine ideas. It uses the input supplied to it to generate a response. That response can include requests to tools, which software executes. Broad knowledge and fluent answers still need checking.

**Harry** runs the dining room. He tracks customers, orders and money. He gives Lalima the information she needs and approves orders before cooking starts. He values her ideas, but sometimes has to rein in her enthusiasm.

> **Harness.** Harry and the restaurant’s procedures represent the software surrounding the model. The harness supplies information, routes requests to tools, returns their results and controls which actions proceed. It also manages limits and when to stop.

**Tim** checks stock, prepares ingredients and cooks according to Lalima’s instructions. He reports what he finds so she can adjust the dish.

The restaurant has no pastry section. Dessert comes from **Baker Bob**, two doors down. Bob runs his own bakery, with his own customers, stock and delivery schedule. Harry checks his menu on the supplier tablet beside the till.

Each morning, Lalima reads her horoscope and pins it above her station. Today it says: “Help people feel cared for. Listen to what they need. Respect their limits. Ask permission before adding expensive extras.” She keeps it in view throughout service.

> **System prompt.** The horoscope represents standing instructions that guide Lalima’s behavior. A system prompt is deliberately supplied by the platform or application as high-priority guidance. It becomes part of the model’s input and leaves its training unchanged. Authority depends on how instructions are supplied. A horoscope fetched by a tool is external content and gains no system authority.

That evening, you arrive with a friend. “Dinner for two, please. We’re vegetarian, and we have $40, including dessert.”

> **User prompt.** Your request supplies the task and its constraints: dinner for two, vegetarian, with dessert, within $40. The system prompt supplies standing guidance for handling requests like yours.

Harry checks your booking note. It says you liked spicy food on your last visit. You ask for less spice tonight. He keeps the old note and adds “less spicy tonight” to the order. Lalima plans to use cumin and roasted vegetables for flavor and leaves the chili aside.

> **Memory and context.** The booking note is stored memory. Retrieving and supplying it to the model makes it part of the current context: the information available for this interaction. Context also includes the system instructions, your request and tonight’s exception. Tool results and the recipe join it when supplied. Tonight’s preference takes precedence over the older preference for this meal.

Harry passes the order and booking details to Lalima. She asks Tim to check whether there is enough eggplant for two. Tim goes to the fridge while she waits for his report.

> **Request.** Harry’s consultation with Lalima represents one model inference request. She responds by asking for a stock check. The model’s response has returned while the requested tool operation is still underway. Your dinner order can lead to many such model requests.

Tim reports that lunch used the last eggplant. Six zucchini remain.

> **Turn.** Lalima’s response and Tim’s stock check form one turn: a model response plus any tool execution and returned results. Tim’s report completes this turn. The next model request supplies that report so Lalima can decide what to do next. This is Pi’s loop terminology; some chat products use “turn” for the entire exchange following a user message.

Lalima changes the dish to stuffed zucchini with lentils and cumin. She tells Tim to halve the zucchini lengthways, scoop out the centers and roast the shells. Zucchini releases more water than eggplant, so he should cook the centers down with onions before adding them to the filling.

> **Tools.** Checking stock, fetching ingredients and preparing a specified dish represent operations the model can request. Tim’s stock report is a tool result. Lalima uses it to choose an alternative, then supplies the details Tim needs to prepare it.

She takes out her old mentor’s lentil recipe card, which has notes on texture and roasting. She adapts it for tonight: save some lentil cooking liquid to adjust the filling, leave out the chili, toast the cumin and save the lemon for the end. Tim lays out the ingredients while Harry prices the meal.

> **Skills.** The recipe card supplies reusable instructions for a particular kind of task. Lalima consults it when relevant and adapts it to the order. A skill can guide a sequence of tool calls, such as preparing the filling and roasting the vegetables.

Lalima suggests adding truffles. Harry calculates a total of $44 for the two mains and Bob’s lemon cake. He requires your approval before accepting a higher bill. Lalima decides to use mushrooms instead.

She tells Tim to slice the caps thick and chop the stems into the filling. He should brown the caps, add a little water to loosen the browned bits in the pan and taste the resulting sauce.

Harry checks the revised total: $38, including both desserts and all charges. He approves the order and sends the cooking ticket through. Tim starts cooking.

> **Budget enforcement.** Lalima follows her instructions but sometimes interprets them too generously. Harry controls the accepted order and blocks an extra charge without your approval. A system prompt guides behavior. The harness must check and enforce a hard spending limit before allowing an action. Calculating the bill is itself a tool operation.

Harry orders two slices of lemon cake for Bob’s next delivery round. Bob and the other suppliers use the same ordering service on the tablet. Each shop lists what it offers. Harry selects the shop, item, quantity and delivery time, then receives an order number for checking progress. Bob requires written orders because a vague phone order once left him preparing for the wrong number of people. The cake order appears as awaiting confirmation.

> **MCP: Model Context Protocol.** The shared way of listing capabilities and accepting requests represents MCP. Harry’s connection plays the client role; each supplier’s service plays the server role. MCP lets an application discover available tools and exchange requests and results in a common format. Each supplier still owns its stock and fulfillment. The application still handles permissions and recovery.

Tim reports that the mushroom sauce tastes rich but needs something. Lalima tastes it and asks for a few drops of lemon. They check it again. She also checks the filling before Tim spoons it into the roasted shells. He adds the browned mushrooms, sauce and parsley. Harry checks the plates against the ticket and serves them.

You and your friend enjoy the meal. It has the flavor you wanted with less spice. Tim writes down Lalima’s instructions for the dish.

The tablet still shows Bob’s order as awaiting confirmation. Lalima suggests sending it again. Harry first calls Bob with the existing order number. Bob has already packed the cake for the next delivery and has yet to update the tablet. Harry keeps the original order. Two slices arrive a few minutes later.

> **Recovery.** A delayed response leaves the outcome uncertain. Harry checks the existing order before repeating it, avoiding a second purchase. In an agent system, looking up the order’s status would be another tool operation.

Lalima plates the cake and suggests adding dark caramel. There is none ready, so she would need to make it. Harry stops the extra work because you are ready for dessert. He serves the cake as it is.

> **Stopping.** Lalima can keep imagining improvements after the meal is ready. Harry ends the extra work and serves it. A harness needs stopping conditions, such as completion, cancellation or reaching a resource limit.

After dessert, Harry brings the bill: $38.

> **Run.** Fulfilling the dinner order represents a run: one period of agent execution containing multiple turns. It includes ingredient decisions, tool actions and responses to their results. A run can end through completion, failure, cancellation or a resource limit. Ending a run does not guarantee success.

As Harry brings your coat, you ask Lalima for the recipe for two people. She uses Tim’s notes to write it down. She explains how to brown the mushrooms in batches in a smaller pan and use the stems in the filling. She includes tonight’s spice choice: leave out the chili, and taste as you add lemon a little at a time.

> **Session.** Your whole visit represents a session: the continuing conversation and its stored history. Dinner was one run. Asking for the recipe starts another run in the same session, using the meal and spice preference as context. A session can persist between runs while no model is working. Its stored history becomes model input only when the harness supplies it in a request.

You leave with the recipe. The kitchen keeps its own copy as “Dinner for two.”

> **Agent.** The whole arrangement pursues your request through decisions, actions and observations. Lalima combines her knowledge with information from the kitchen to plan and adjust the meal. Harry coordinates the work and enforces limits. Tim and the supplier services carry out actions. The model, harness and tools together form the agent system.

## Character boundaries for later stories

- **Lalima** draws on broad knowledge, combines ideas, adapts to constraints and gives clear instructions. She cares about diners and sometimes interprets her horoscope too generously.
- **The horoscope** supplies standing behavioral instructions throughout service. Changing it can change Lalima’s approach while leaving her cooking knowledge intact.
- **Harry** controls service, accepted orders, records and spending. He responds to customers, costs and kitchen timing.
- **Tim** performs requested work and reports what he finds. He needs detailed instructions as Lalima’s plan changes.
- **Bob** runs an independent bakery. His stock, order records and delivery schedule belong to his business.

These are roles in an analogy. Lalima’s senses stand for observations supplied to the model, including tool results. Tim and Harry have human intelligence beyond the software roles they illustrate. Another reasoning agent would need a separate decision-making role.

## Dimensions of an Agent

An agent can follow a fixed checklist or choose its next investigation. It can wait for a message or wake on a schedule. These are independent design choices, including choices within the same product. Some form a scale; others describe categories. The scenarios below are illustrative; the last column connects them to real products.

| Dimension | Product Idea | One design | Another design | Real product parallels |
| --- | --- | --- | --- | --- |
| **Control**<br>Who chooses the path through the task? | **Suppose you want to prepare for an exam next week.** A tutor helps you study. | **A fixed study routine.** The application summarizes each chapter, generates practice questions, then grades your answers. It takes every student through the chapters in the same order. | **The model chooses what to work on next.** It asks a few questions, notices where you struggle, tries a worked example, then checks your understanding again. Your answers determine whether it changes the explanation, gives more practice or moves to another topic. | **Copilot inline suggestions:** you choose where to work and which suggestion to accept. **Copilot agent mode:** it chooses files to inspect or change and commands to run, subject to approval. [Copilot modes](https://docs.github.com/en/copilot/quickstart). |
| **Trigger**<br>What starts the work? | **A restaurant inventory manager.** Helps keep the kitchen stocked. | **A restaurant manager asks.** Before opening, you tap “Check what we need to order.” The inventory agent starts inspecting stock and preparing its recommendations. | **A clock or event starts it.** The same agent wakes every morning before service. Alternatively, a stock update showing that the rice bin has fallen below its threshold starts the work immediately. | **OpenClaw** can receive chat messages or wake on a schedule. **Copilot cloud agent automations** can start on schedules or events such as a newly opened issue. [OpenClaw messaging](https://docs.openclaw.ai/); [scheduling](https://docs.openclaw.ai/automation/cron-jobs); [Copilot automations](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent). |
| **Authority**<br>What may it do without further approval? | **An automated stock broker.** Investigates trading opportunities and prepares orders. | **Each order waits for approval.** It investigates an opportunity, chooses a proposed trade and fills out the order ticket. The ticket waits beside an **Approve trade** button before anything is submitted. | **The broker has delegated trading authority.** It can submit buy and sell orders within the account owner’s approved instruments, position sizes and spending limits. Crossing those boundaries requires approval. The research could be identical in both versions; the execution permissions differ. | **Claude Code** has Plan mode for investigation, accept-edits mode for permitted file changes, and individual allow/ask/deny rules. Its software enforces those permissions. [Claude Code permissions](https://code.claude.com/docs/en/permissions). |
| **Duration**<br>How long does the responsibility continue? | **A vending-machine manager.** An agent embedded in the machine manages its operation. | **A bounded restocking task:** “Arrange today’s restock.” It checks the empty slots, orders supplies, coordinates delivery and confirms replenishment. That task then ends. | **The embedded agent manages the machine continuously.** It watches sales and stock, orders replenishment, arranges restocking, raises or lowers displayed prices, handles delayed deliveries and checks whether its changes worked. Its responsibility continues across days and restarts. Individual runs can finish while the overall job remains active, waiting for the next event. | **Copilot Chat** can finish with one explanation; **Copilot cloud agent** can work independently on a background task. **Claude Code** can resume retained subagent history. These illustrate bounded work, background execution and resumability. [Copilot Chat](https://docs.github.com/en/copilot/quickstart); [cloud agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent); [resuming subagents](https://code.claude.com/docs/en/sub-agents). |
| **Environment**<br>Through what surfaces does it observe and act? | **A travel planner.** Searches, books, changes and cancels trips. | **The travel planner uses Expedia MCP.** Assume a server with tools to search, book, change and cancel trips. The agent supplies structured fields such as destination and dates, then reads availability, prices and booking confirmations from tool results. | **The travel planner uses a browser.** It opens Expedia, operates the date picker, changes filters, scrolls through hotel cards and completes booking, change or cancellation forms. It can carry out the same tasks in both versions; the observations and available actions change. | **Perplexity Comet** can interact with browser pages. **Muse Code** operates through project files and shell commands. [Comet use cases](https://www.perplexity.ai/help-center/comet/en/articles/11732243-advice-and-use-cases); [Muse Code](https://ai.developer.meta.com/docs/muse-code). |
| **Topology**<br>How is decision-making distributed? | **An on-call assistant.** Investigates service outages and proposes recovery actions. | **One agent investigates the outage.** It moves between application logs, database metrics and deployment history, develops a hypothesis and proposes a recovery action within one agent context. | **A coordinator divides the investigation.** One agent examines the database, another inspects the latest deployment, and another investigates incoming traffic. Each follows its own leads in its own context. Their findings return to the coordinator, which reconciles them and prepares the response. | **Claude Code** supports a main conversation and specialist subagents with separate contexts, instructions and tool access. It documents both parallel investigations and sequential reviewer-to-optimizer workflows. [Claude Code subagents](https://code.claude.com/docs/en/sub-agents). |
| **Memory**<br>What is retained and retrieved across interactions? | **An always-on clothing assistant in a store’s mirror.** Helps shoppers choose a fit. | **The mirror uses the current fitting and chart details.** You hold up a jacket; the mirror outlines the shoulders and offers sizing guidance using chart details supplied in its system prompt and what you show or tell it now. Each visit begins without your previous fitting history. | **The same mirror remembers regular customers through files.** When an identified regular walks into the store, the harness loads their customer file: “Prefers a loose fit; returned this brand’s medium because the shoulders were tight.” The mirror can suggest a different size immediately and save new feedback for another visit. The stored file becomes context when loaded. | **Claude Code** can retain preferences and corrections through auto memory. **OpenClaw** stores durable information and daily notes in files that later interactions load or retrieve. [Claude Code memory](https://code.claude.com/docs/en/memory); [OpenClaw memory](https://docs.openclaw.ai/concepts/memory). |
| **Interface**<br>How do people interact with the agent? | **A co-designer.** Helps you revise a design and its interactive prototype. | **The co-designer works through a chat app.** You type “Make this checkout clearer,” attach the design and receive a revised preview. Further direction arrives through messages; results return through text and attachments. | **A fictional, fully agentic Figma makes the canvas the conversation.** You circle an awkward section, drag a card or select a button. Your co-designer rearranges nearby components, adjusts spacing and updates the interactive prototype as you work together. You steer through the design itself. | **OpenClaw** offers messaging interfaces such as WhatsApp and Telegram. **Muse Code** offers an interactive terminal and a headless mode. **Comet** places its assistant beside the browser page. [OpenClaw channels](https://docs.openclaw.ai/); [Muse Code modes](https://ai.developer.meta.com/docs/muse-code); [Comet assistant](https://www.perplexity.ai/help-center/comet/en/articles/11732243-advice-and-use-cases). |

Each system combines choices across these dimensions. A product name alone cannot tell us its permissions, memory settings or coordination pattern. The useful comparison names the product, its mode and the task it is performing.

Product examples are grounded in official documentation checked on October 5, 2026.
