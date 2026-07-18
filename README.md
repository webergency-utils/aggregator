# @webergency-utils/aggregator

[![NPM Version](https://img.shields.io/npm/v/@webergency-utils/aggregator)](https://www.npmjs.com/package/@webergency-utils/aggregator) [![NPM Downloads](https://img.shields.io/npm/dm/@webergency-utils/aggregator)](https://www.npmjs.com/package/@webergency-utils/aggregator) [![License](https://img.shields.io/npm/l/@webergency-utils/aggregator)](https://github.com/webergency-utils/aggregator/blob/main/LICENSE)

A highly efficient TypeScript batching utility that groups, deduplicates, and chunks concurrent asynchronous requests within the same execution tick. It is designed to optimize database queries, API calls, and external resource fetching by consolidating individual operations into structured batch calls.

## TL;DR

```typescript
import Aggregator from '@webergency-utils/aggregator';

interface User {
  id: string;
  name: string;
}

// 1. Define the batch fetch callback
const fetchUsersBatch = async (ids: string[]): Promise<Record<string, User>> => {
  console.log(`Fetching batch of users: ${ids.join(', ')}`);
  
  // Simulate database call returning Map/Record of user ID -> User
  return ids.reduce((acc, id) => {
    acc[id] = { id, name: `User ${id}` };
    return acc;
  }, {} as Record<string, User>);
};

// 2. Initialize the Aggregator
const userAggregator = new Aggregator<string, User>(fetchUsersBatch, {
  limit: 100, // Maximum batch size per callback call
  delay: 0,   // Delay in ms before flushing (0 defaults to nextTick/queueMicrotask)
});

// 3. Execute concurrent calls in the same tick
async function run() {
  const [userA, userB, userC] = await Promise.all([
    userAggregator.execute('user-1'),
    userAggregator.execute('user-2'),
    userAggregator.execute('user-1'), // Automatically deduplicated!
  ]);

  console.log(userA); // { id: 'user-1', name: 'User user-1' }
  console.log(userB); // { id: 'user-2', name: 'User user-2' }
  console.log(userC); // { id: 'user-1', name: 'User user-1' } (Reuses result of user-1)
}

run();
```

## Architecture & Internals

`@webergency-utils/aggregator` solves the N+1 query problem by batching multiple standalone asynchronous operations that occur close in time (such as within a single event loop tick or a specific time window) into a single batch request.

### Tick-Based Batching
When `.execute()` is called, the ID and any optional arguments are enqueued, and a flush timer is scheduled. By default, the flush happens on `process.nextTick` or `queueMicrotask` depending on the runtime environment. Alternatively, a custom `delay` in milliseconds can be set to buffer queries over a longer window.

### Deduplication & Piggybacking
Identical IDs requested in the same batch are automatically deduplicated. Only a single instance of the ID is sent to the batch callback. In addition, if a fetch is already in flight for a given batch context and a new request comes in for an ID that is part of that in-flight request, the aggregator will "piggyback" on the pending operation, returning the same promise result without initiating a new batch.

### Argument-Based Grouping
Batching is scoped by any additional arguments passed to `.execute()`. For instance, calling `execute('user-1', 'shard-A')` and `execute('user-2', 'shard-B')` will construct two separate batches because the grouping arguments differ. The arguments array is serialized and hashed using `@webergency-utils/object-hash` to generate a unique batch channel identifier.

### Chunking (Limits)
If the number of unique IDs gathered in a batch exceeds the configured `limit`, the aggregator splits them into smaller slices (chunks). Each chunk executes independently, and their results are merged back seamlessly to resolve the original query promises.

### Error Routing & Batch Errors
The aggregator routes errors granularly:
* **Single ID query:** If the batch callback returns an `Error` object for a specific ID, the corresponding `.execute(id)` call rejects with that error.
* **Array-ID query:** If an array of IDs is fetched and any of them resolves to an `Error`, the `.execute(ids)` call rejects with an `AggregatorBatchError` detailing which keys failed (`errors`) and which ones succeeded (`resolved`).

### External Dependencies
* `@webergency-utils/object-hash`: Utilized internally to stringify and hash additional query arguments for batch grouping.

## Glossary

* **`Aggregator`**: The orchestrator class that aggregates individual IDs, handles deduplication, groups by arguments, and schedules the execution.
* **`execute`**: Enqueues request(s) and returns a promise resolving to the fetch result.
* **`pause`**: Suspends the scheduler from flushing pending batches.
* **`resume`**: Restarts the scheduler to flush pending batches.
* **`drain`**: Flushes all batched requests and resolves once all pending operations finish.
* **`AggregatorBatchError`**: Custom exception class containing granular details of failed and resolved keys within a batch.
* **`AggregatorCallback`**: User-supplied function executing the actual batch operation.
* **`AggregatorOptions`**: Configuration object to customize batch limits, delays, timeouts, and key normalization.

## API Reference

### `Aggregator` (Class)

The primary entry point for managing batched operations.

#### `constructor`

```typescript
constructor(callback: AggregatorCallback<ID, V>, options?: AggregatorOptions<ID>)
```

Initializes a new `Aggregator` instance with a batch callback and optional configuration settings.

* **Parameters**:
  - `callback`: `AggregatorCallback<ID, V>` — The batch resolver function.
  - `options`: `AggregatorOptions<ID>` (Optional) — Custom limits, delays, timeouts, or ID normalization settings.

* **Code Example**:
```typescript
const agg = new Aggregator(async (ids) => fetchFromDb(ids), { limit: 50 });
```

---

### `execute`

Enqueues one or more IDs for batch retrieval and returns a promise for the result.

* **Parameters**:
  * `ids`: `ID | ID[]` — A single ID or an array of IDs to fetch.
  * `...args`: `any[]` (Optional) — Extra arguments passed directly to the callback (also used to group batches).

* **Returns**: `Promise<V> | Promise<V[]>`
  * Returns `Promise<V>` if a single ID was passed.
  * Returns `Promise<V[]>` mapping the results in the exact same order if an array of IDs was passed.

* **Code Example**:
```typescript
// Fetching a single entity
const user = await agg.execute('user-123');

// Fetching multiple entities in one call
const users = await agg.execute(['user-1', 'user-2']);

// Passing extra arguments for grouping
const result = await agg.execute('user-1', 'database-shard-A');
```

---

### `pause`

Suspends the scheduler, preventing queued batches from flushing automatically.

* **Parameters**: None.
* **Returns**: `void`
* **Code Example**:
```typescript
agg.pause();
// Future execute calls will queue up but won't be flushed automatically
```

---

### `resume`

Resumes the scheduler, immediately scheduling a flush of any queued batches.

* **Parameters**: None.
* **Returns**: `void`
* **Code Example**:
```typescript
agg.resume();
// Scheduler resumes and schedules a batch flush on the next tick
```

---

### `drain`

Force-flushes any currently queued batches and returns a promise that resolves once all active batches are fully resolved.

* **Parameters**: None.
* **Returns**: `Promise<void>` — Resolves when all pending and active batches finish execution.
* **Code Example**:
```typescript
await agg.drain();
// Guaranteed that all queues are clear and all calls have resolved/rejected
```

---

### `AggregatorBatchError` (Class)

Custom error thrown when an array-ID query contains one or more errors in the batch.

* **Properties**:
  * `errors`: `Record<any, Error>` — A dictionary mapping the normalized ID to its specific error instance.
  * `resolved`: `Record<any, any>` — A dictionary mapping the normalized ID to its successfully resolved value.

* **Methods**:
  * `toString()`: Returns a readable string listing the failed keys.
  * `toJSON()`: Returns a serializable representation of the error.

* **Code Example**:
```typescript
try {
  await agg.execute(['user-ok', 'user-broken']);
} catch (err) {
  if (err instanceof AggregatorBatchError) {
    console.error(err.errors['user-broken']); // The specific Error object
    console.log(err.resolved['user-ok']);     // The successfully fetched user-ok data
  }
}
```

---

### `AggregatorOptions` (Interface)

Configuration options passed to the `Aggregator` constructor.

* **Properties**:
  * `limit`: `number` (Optional) — Maximum batch size. If the batch exceeds this, it is split into multiple chunks. Default: `Infinity`.
  * `delay`: `number` (Optional) — Minimum delay in milliseconds before flushing the batch. Default: `0` (runs on `nextTick` / `queueMicrotask`).
  * `timeout`: `number` (Optional) — Timeout in milliseconds. If batch execution takes longer, the batch is aborted and all pending requests reject. Default: `undefined`.
  * `normalizeID`: `(id: ID) => any` (Optional) — A transformation function to normalize IDs (e.g. serialize objects to strings) before hashing and indexing.

---

### `AggregatorCallback` (Type)

The signature of the batch resolver function.

```typescript
type AggregatorCallback<ID, V> = (
  ids: ID[],
  ...args: any[]
) => Record<any, V> | V[] | Promise<Record<any, V> | V[]>;
```

* **Behavior**:
  * Receives a list of unique `ids` to retrieve, along with any optional grouping arguments.
  * Can return either:
    1. A dictionary/record where keys are the normalized IDs, and values are of type `V` or `Error`.
    2. An array of values or errors matching the order of input `ids`.
  * If a value in the response is an instance of `Error`, that specific key will be rejected.
