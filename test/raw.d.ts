// Vite raw imports, used by tests that check migration SQL directly.
declare module "*?raw" {
  const text: string;
  export default text;
}
