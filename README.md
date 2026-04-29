# vmjs

VM for JS in JS

## Installation

```sh
bun add vmjs
```

## Development

Install dependencies:

```sh
bun install
```

Run tests:

```sh
bun test
```

Build the library:

```sh
bun run build
```

Run type checking:

```sh
bun run typecheck
```

## Usage

```ts
import { greet } from "vmjs";

console.log(greet({ name: "world" }));
```
