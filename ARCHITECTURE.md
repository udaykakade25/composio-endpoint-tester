# Architecture

### 1. **Design overview** — How does your agent work? What's the high-level flow?

**Phase 1 — Context Gathering:**:
Before making any API Endpoin, we use agent to pre-fetch the below context which would be used later.

- `userEmail` — fetched from Gmail profile, used to construct valid RFC 2822 email bodies for send/draft endpoints
- `messageId` — the most recent Gmail message ID, needed for endpoints that have `{messageId}` in their path
- `eventId` — a pre-existing Google Calendar event ID, used as a fallback for endpoints that require `{eventId}`

**Phase 2 — Sequential Endpoint Testing:**

Agent loops through total 16 points one by one (first Gmail then Calendar).

For each endpoint:

1. We resolve Path Parameters using pre-fetched data that we have
2. Build mimimum valid request body using Parameter definition
3. Call the real API using Composio's `proxyExecute`
4. Extract HTTP status code using `extractHttpStatus` and classify the endpoint
5. Record this classified API endpoint in report.json

### 2. **Dependency resolution** — How does your agent handle endpoints that need data from other endpoints (e.g., fetching an ID before calling a detail endpoint)?

We pre-fetch some of data before making API call. Some endpoints require ID in their path which comes from prior API call.

`messageId`: `GET /gmail/v1/users/me/messages?maxResults=1` is fetched before making endpoint API calls, meaning all the endpoint that require `messageId` can reuse this message id.
`eventId`: `GET /calendar/v3/calendars/primary/events?maxResults=1` Similar to `messageId`, we fetch Event ID which is later used across serveral API calls.

3. **Avoiding false negatives** — How does your agent minimize misclassifying valid endpoints invalid due to its own mistakes (bad params, missing body, etc.)?

- Real IDs in path: We provide real IDs (`GET /messages/{messageId}`). Use of demo/fake ID would definetly provide 404 while valid ones provides accurate data.
- `HTTP Status`: Using `extractHttpStatus` - we check status code across serveral locations in response (`result.data.status`, `result.data.response_data.status`) thus extracting correct status code.
- Providing Accurate Request Body: Using `buildBody` function, we format and encode data to base64url which is used for sending and drafting the email, Thus avoiding 4XX errors.

4.  **Classification logic** — How does your agent decide between valid, invalid_endpoint,insufficient_scopes, and error?

Based on HTTP response and status code, we determine if the endpoint was valid or not. Using API's own response accurately validiates our endpoints.

- 2xx - valid
- 404, 405, 501 - invalid (URL Path does not exist)
- 401, 403 - insufficient_scopes - connected accounts has not permission to access the data
- OTHER - error

5. **Tradeoffs** — What tradeoffs did you make? What would you improve with more time?

**PRIORITIZED:**

- Accuray > Speed (All endpoints are correctly validiated)
- `available_scopes`: This property is always `[]` thus we don't fetch for actual OAuth scopes that are available in our account.
- Order: Endpoints are ordered in such a way that sequence matters.
  We DRAFT EMAIL before DELETING it.
- Sequential Execuation of API Endpoints: `DELETE_EVENT` depends on `CREATE_EVENT` similary `TRASH_MESSAGE` depends on `CREATE_DRAFT`

**With more time:**

- We can fetch all the `available_scopes` from Composio's connected user account.
- Parallel execution for independent endpoints
- Ensure there is no strict depedency across various endpoints.
- Retry logic for consistent network failures

6. **Architecture pattern** — Why did you choose your particular pattern (single agent, multi-agent, orchestrator, etc.)? What are the pros and cons?

The agent uses a **single sequential agent** instead of orchestrator or multi-agent.

**Reasons:**

- There are just 16 endpoints and that too dependent on each other.
- Depedencies between various endpoints across Gmail and Google Calendar.
  For Google Calendar: DELETE_EVENT and GET_EVENT endpoints are dependent on CREATE_EVENT thus singe agent handles it perfectly.

**Pros:**

- Simple to maintain
- Sequential behaviour ensures required scopes and depedencies are available and satisfied
- Easy to debug error

**Cons:**

- Agent needs to be sequentially run.
- Extremely hard to maintain for hundreds of endpoints
- If the agent crashes in midway, we get half and partial result data.
