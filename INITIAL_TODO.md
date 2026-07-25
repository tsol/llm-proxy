# Task: Create an OpenAI-Compatible Forwarder and Model Router

## Context
We want to route all LLM chat completion traffic through a custom Node.js forwarder (router.js) sitting in our ~/hermes folder. This proxy will act as a transparent OpenAI-compatible interface (/v1/chat/completions). It will let us dynamically flip the active backend destination midway using an external routing state API call, seamlessly hot-swapping between our local gemma-4-12b model and our remote paid GONKA models.

---

## 🛠️ Implementation Steps

### 1. Initialize Project Workspace
Create a baseline package.json file inside the ~/hermes folder and install the required streaming/forwarding dependencies. Run these commands directly in your workspace terminal:

> `npm init -y`
> `npm install express cors body-parser axios`

### 2. Create the Routing Architecture (router.js)
Build a Node.js application (router.js) listening on a local port (e.g., 5001). Implement the following specifications:

* **Target Upstream Destinations:**
  - Local Backend (LM Studio): http://localhost:1234/v1/chat/completions
  - Remote Backend (GONKA Models): Provide a configurable URL and Authorization header path for your OpenAI-formatted remote service.

* **Dynamic Routing State:**
  - Implement an internal string flag `currentRouterState`. Default it to "local".
  - Expose an administrative endpoint `POST /v1/router/switch` to change this state on the fly via external commands.
  - Sending `{ "target": "local" }` forces the proxy to forward requests to LM Studio (renaming the inbound model parameter to "gemma-4-12b" if needed).
  - Sending `{ "target": "remote" }` forces the proxy to forward requests to the cloud API endpoint (mapping the request to your targeted GONKA model).

* **Request Forwarding Logic:**
  - Listen on `POST /v1/chat/completions`.
  - Capture the incoming headers and body payload.
  - If streaming is requested (`stream: true`), ensure the server properly streams chunk responses (`text/event-stream`) from the selected upstream target back to the client without dropping or buffering the connection midway.



For possible modles please take look at:


This is one of the providers:

 /home/harry/.local/bin/gonka-cline-model


The other provider would be google cloud -- work with it could be seen in
~/harry/projects/repo/words/


---

## 🏗️ Architectural Assurance Checklist
* **Statelessness:** The proxy must remain completely agnostic of the message conversation array. Its sole job is to inspect `currentRouterState`, adjust the model parameter string if necessary, inject the correct authorization token for remote requests, and forward the request.
* **Transparent Compatibility:** Ensure response objects, status codes, and error payloads are passed back to Hermes cleanly so it perceives the router as a standard, compliant OpenAI endpoint.


Credentials for all the provides should be set in .env file

Adapters should be universal.

System should be able to count tokens and their cost per request and store
it (for now in text file costs.log -- one line one entry -- columns - model, tokens in out dollars spent)


system should be expandable. where open ai compatable endpoint does not
provide information -- defaults should be able to specified in .env file


switch of the models and list of the models should be accessable via service
functions and those functions called via http rest api -- no auth yet

we should use TYPESCRIPT not javascript.


so providers shpuld be 
1. local llm studio 
2. gonka proxy
3. google gloud (gemini-flash / mini)

must be expandable

each providers should provide list of models to us, cost for tokens, token usage
and we should give that away as open ai compatable protocol for hermes.

make sure while switching that we do not break current inference if it is
running -- unless force command is specified.












