import { RuleCategory } from './rules-store';

export interface BuiltInRule {
  id: string;
  name: string;
  category: RuleCategory;
  text: string;
}

export const BUILT_IN_RULES: BuiltInRule[] = [
  {
    id: 'builtin-solid',
    name: 'SOLID Principles',
    category: 'code-quality',
    text: `Follow SOLID design principles:
- Single Responsibility: each class/function has one reason to change
- Open/Closed: open for extension, closed for modification
- Liskov Substitution: subtypes must be substitutable for their base types
- Interface Segregation: prefer small, focused interfaces over large monolithic ones
- Dependency Inversion: depend on abstractions, not concrete implementations`,
  },
  {
    id: 'builtin-owasp',
    name: 'OWASP Security (Top 10)',
    category: 'security',
    text: `Apply OWASP Top 10 security awareness to all code:
- Validate and sanitize every piece of user input before use
- Never trust data from external sources — APIs, files, query params, cookies
- Use parameterized queries — never concatenate user input into SQL
- Flag any user input reaching a DB query, log statement, file path, or shell command
- Store secrets in environment variables, never in source code or version control
- Enforce authentication and authorization checks on every sensitive operation`,
  },
  {
    id: 'builtin-clean-code',
    name: 'Clean Code',
    category: 'code-quality',
    text: `Write clean, readable code:
- Use meaningful, intention-revealing names for variables, functions, and classes
- Functions should do one thing and do it well (under 20 lines where practical)
- Avoid magic numbers — use named constants
- No dead code, no commented-out code blocks left behind
- Prefer explicit early returns over deeply nested conditionals`,
  },
  {
    id: 'builtin-tdd',
    name: 'Test-Driven Development',
    category: 'testing',
    text: `Apply TDD practices:
- Write tests before or alongside implementation
- Each public function should have at least one unit test
- Tests must be independent, deterministic, and fast
- Cover edge cases: null/undefined inputs, empty collections, boundary values
- Mock external dependencies (databases, APIs, filesystem) in unit tests`,
  },
  {
    id: 'builtin-self-documenting',
    name: 'Self-Documenting Code',
    category: 'code-quality',
    text: `Write self-documenting code — minimize comments:
- Use descriptive variable and function names instead of inline comments
- Only add a comment when the WHY is non-obvious (a workaround, an invariant, a hidden constraint)
- Do not explain WHAT the code does — well-named identifiers already communicate that
- No multi-paragraph docstrings on trivial functions`,
  },
  {
    id: 'builtin-error-handling',
    name: 'Robust Error Handling',
    category: 'architecture',
    text: `Handle errors correctly at every layer:
- Never swallow exceptions silently — either handle them or propagate them
- Provide meaningful error messages with enough context to diagnose the problem
- Validate inputs at system boundaries (user input, external APIs)
- Use structured error types rather than generic Error strings where possible
- Log errors with stack traces and the relevant context at the time of failure`,
  },
  {
    id: 'builtin-perf',
    name: 'Performance Awareness',
    category: 'performance',
    text: `Write performant code:
- Avoid N+1 query patterns — use bulk fetches or joins
- Cache expensive computations that are called repeatedly
- Choose appropriate data structures: Map/Set over Array for lookups
- Profile before optimizing — do not optimize speculatively
- Avoid blocking the event loop in async/concurrent contexts`,
  },
  {
    id: 'builtin-dry',
    name: 'DRY / No Duplication',
    category: 'architecture',
    text: `Follow the DRY (Don't Repeat Yourself) principle:
- Extract repeated logic into a shared function or module
- Three similar code blocks is the threshold — abstract on the third repetition
- Prefer configuration over duplication in similar code paths
- Avoid copy-paste programming`,
  },
  {
    id: 'builtin-dev-workflow',
    name: 'Dev Workflow',
    category: 'custom',
    text: `Before writing any code for this task:
1. Read the files most relevant to this task — understand existing patterns first.
2. Check if a utility, helper, or abstraction already exists before creating a new one.
3. Match the naming conventions and code style of the files you are editing.
4. After completing: run the project lint/build check and confirm no regressions.`,
  },
];
