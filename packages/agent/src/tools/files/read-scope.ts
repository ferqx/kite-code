import { basename, dirname, extname } from 'node:path';
import { AgentError } from '../../storage/types';

const extensions = new Set(
  `adb ads adoc asm astro awk bzl c cc cjs clj cljs cmake cmd coffee cpp cs csproj css cts cxx dart diff
  edn elm erl ex exs f90 fish fs fsi fsx go gradle gql graphql groovy h hcl hh hpp hrl html htm hxx ini
  java jl js json jsonc json5 jsx kt kts less lisp lock lua md markdown mdx mjs mm mts nix php pl pm
  proto ps1 psd1 psm1 py pyi r rb reg rs rst sass scala scss sh sln sql svg swift svelte tex tf tfvars
  toml ts tsx txt v vb vhdl vue xml yaml yml zig zsh`.split(/\s+/),
);
const names = new Set(
  `.babelrc .bazelrc .clang-format .clang-tidy .dockerignore .editorconfig .eslintignore .eslintrc
  .gitattributes .gitconfig .gitignore .gitmodules .npmignore .npmrc .prettierignore .prettierrc
  .yarnrc agents brewfile build changelog cmakelists.txt codeowners contributing gemfile go.mod go.sum
  justfile license licence makefile notice procfile rakefile readme requirements.txt vagrantfile
  workspace`.split(/\s+/),
);

export const pdfHeaderSearchBytes = 1024;

export function isEngineeringTextPath(path: string): boolean {
  const leaf = basename(path).toLowerCase();
  const parent = dirname(path);
  const workingCopy =
    basename(dirname(parent)).toLowerCase() === '.kite-inputs' &&
    /^[a-f0-9]{64}$/i.test(basename(parent)) &&
    leaf.startsWith('input-');
  const name = (workingCopy ? leaf.slice(6) : leaf).replace(/\.(?:example|sample|template)$/, '');
  return (
    names.has(name) ||
    /^(?:dockerfile|containerfile|makefile)(?:\.[a-z0-9_-]+)?$/.test(name) ||
    /^\.env(?:\.[a-z0-9_-]+)?$/.test(name) ||
    extensions.has(extname(name).slice(1))
  );
}

/** Match a PDF header line, allowing leading bytes while ignoring inline source literals. */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  const header = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.byteLength, pdfHeaderSearchBytes),
  ).toString('latin1');
  return /(?:^|[\r\n])(?:\xef\xbb\xbf)?[ \t]*%PDF-[12]\.[0-9](?=$|[\r\n \t])/.test(header);
}

export function unsupportedFileRead(
  path: string,
  options: { name?: string; savedAttachment?: boolean } = {},
): AgentError {
  const extension = extname(options.name ?? path).toLowerCase();
  const route =
    extension === '.pdf'
      ? 'Use exec_command with the bundled KITE_DOCUMENTS_HELPER pdf-text for selected pages, or pdf-render followed by view_images for visual inspection.'
      : ['.docx', '.xlsx', '.pptx'].includes(extension)
        ? 'Use the corresponding Office skill and OfficeCLI via exec_command.'
        : ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)
          ? 'Use view_images to inspect this image.'
          : 'Use exec_command with a format-appropriate reader and return only the relevant content.';
  const source = options.savedAttachment
    ? ' Use the attachment’s workspace copy supplied with the message. Reattach the file if a workspace copy is unavailable.'
    : '';
  return new AgentError(
    'unsupported_file_type',
    `unsupported_file_type (${JSON.stringify(path)}): read_file accepts source and engineering text. ${route}${source}`,
  );
}
