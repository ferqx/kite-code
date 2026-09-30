let input = '';

export {};

for await (const chunk of Bun.stdin.stream()) {
  input += new TextDecoder().decode(chunk);
  const newline = input.indexOf('\n');
  if (newline < 0) continue;
  const request = JSON.parse(input.slice(0, newline)) as {
    jsonrpc: string;
    id: number;
    params: { text: string };
  };
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.params })}\n`,
  );
  break;
}
