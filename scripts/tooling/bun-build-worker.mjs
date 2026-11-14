import { compileInBun } from './bun-build.ts';

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
  const result = await compileInBun(config, [
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
  ]);
  const outputs = await Promise.all(
    result.outputs.map(async (output) => ({
      path: output.path,
      kind: output.kind,
      type: output.type,
      contents: Buffer.from(await output.arrayBuffer()).toString('base64'),
    })),
  );
  return { kind: 'result', ...result, outputs };
}

process.on('message', async (message) => {
  if (message.kind === 'callback') {
    const pending = callbacks.get(message.id);
    callbacks.delete(message.id);
    if (message.error) pending.reject(Error(message.error));
    else pending.resolve(message.value);
  } else if (message.kind === 'build') {
    try {
      process.send(await bundle(message), (error) => {
        if (error) {
          console.error(error);
          process.exitCode = 1;
        }
        if (process.connected) process.disconnect();
      });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 2;
      if (process.connected) process.disconnect();
    }
  }
});
