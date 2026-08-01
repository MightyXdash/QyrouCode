declare module 'mammoth' {
  export interface MammothResult {
    value: string
    messages: unknown[]
  }

  export function extractRawText(input: { buffer: Buffer }): Promise<MammothResult>
}
