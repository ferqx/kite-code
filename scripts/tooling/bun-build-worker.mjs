const expectedVersion = '1.4.4';
if (Bun.version !== expectedVersion) {
  console.error(`Bun ${expectedVersion} is required for bundling (found ${Bun.version}).`);
  process.exit(2);
}

let nextId = 0;
const callbacks = new Map();
function invoke(kind, index, args) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    callbacks.set(id, { resolve, reject });
    process.send({ kind, index, id, args }, (error) => {
      if (!error) return;
      callbacks.delete(id);
      reject(error);
    });
  });
}

async function bundle({ config, resolvers, loaders }) {
  const pattern = ({ source, flags, namespace }) => ({
    filter: new RegExp(source, flags),
    ...(namespace === undefined ? {} : { namespace }),
  });
  try {
    const result = await Bun.build({
      ...config,
      plugins: [
        {
          name: 'kite-build-hooks',
          setup(builder) {
            for (const [index, item] of resolvers.entries()) {
              builder.onResolve(pattern(item), (args) => invoke('resolve', index, args));
            }
            for (const [index, item] of loaders.entries()) {
              builder.onLoad(pattern(item), (args) => invoke('load', index, args));
            }
          },
        },
      ],
    });
    const outputs = config.outdir
      ? []
      : await Promise.all(
          result.outputs.map(async (output) => ({
            path: output.path,
            kind: output.kind,
            type: output.type,
            contents: Buffer.from(await output.arrayBuffer()).toString('base64'),
          })),
        );
    return { kind: 'result', success: true, outputs, logs: result.logs.map(diagnostic) };
  } catch (error) {
    return {
      kind: 'result',
      success: false,
      outputs: [],
      logs: (error instanceof AggregateError ? error.errors : [error]).map(diagnostic),
    };
  }
}

function diagnostic(error) {
  const position = error?.position;
  return {
    text: error?.message ?? String(error),
    location: position?.file ? { file: position.file, line: position.line } : null,
  };
}

process.on('message', async (message) => {
  if (message.kind === 'callback') {
    const pending = callbacks.get(message.id);
    callbacks.delete(message.id);
    if (message.error) pending.reject(Error(message.error));
    else pending.resolve(message.value);
  } else if (message.kind === 'build') {
    process.send(await bundle(message), (error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
      if (process.connected) process.disconnect();
    });
  }
});
