# Testing Knowledge Base — Aggregator Library

## Rules

- **Strict AAA Structure:** Every test block must be organized clearly into `// Arrange`, `// Act`, and `// Assert` sections, separated by blank lines.
- **Strict Isolation:** Ensure zero shared state between test cases. Use `beforeEach` to instantiate fresh objects and clear mock call histories (`vi.clearAllMocks()`).
- **Keyword and Parentheses Spacing:** No spaces between keywords and their opening parentheses (e.g., `if( condition )`, `catch( e )`). Inside the parentheses, add spaces immediately at boundaries (e.g., `( arg1, arg2 )`, `expect( callback )`).
- **Allman Bracing:** Opening braces `{` for blocks, classes, functions, and multiline control statements must start on a new line and vertically align with the parent block.
- **Single-Line Compacting:** Single-statement blocks (such as simple returns or throws) should be compacted onto a single line without trailing semicolons inside the braces (e.g., `if( condition ){ return }`).

## Anti-Patterns

- **No generic `test` blocks:** Always use `it` blocks instead of `test`.
- **No shared state mutation:** Do not mutate variables declared at the file/describe level across different tests.
- **No trailing commas:** Trailing commas are banned under the radixxko coding standard.
- **No unpadded parentheses:** Do not call functions or declare signatures like `fn(arg)`; always use `fn( arg )`.

## Mocking Conventions

- **Safe Mocking:** Explicitly define mock function typings where appropriate. Avoid using `any`; type parameters properly.
- **Callback Mocking:** Use `vi.fn()` for lightweight callbacks to intercept list keys and return mapped values.
- **Asynchronous Mocks:** When testing asynchronous/delayed execution, use deferred promises to resolve callbacks deterministically.
- **Timeout Rejection Caching:** When testing asynchronous rejections like timeouts, capture the rejected promise immediately using `const pCheck = p.catch( e => e )` before letting time pass. This prevents unhandled promise rejection warnings/errors from bubble-up.
- **Key Normalization mapping:** When testing complex objects as IDs, utilize the optional `normalizeID` function. Always verify in assertions that the aggregator correctly maps resolved values back to the original queried complex IDs.
