export interface GreetingOptions {
  name: string;
}

export function greet({ name }: GreetingOptions): string {
  return `Hello, ${name}!`;
}
