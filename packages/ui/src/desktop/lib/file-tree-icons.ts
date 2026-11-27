import manifest from 'material-icon-theme/dist/material-icons.json';

type Associations = Readonly<Record<string, string>>;

export const fileTreeIconDirectory = 'file-tree-icons';

const definitions: Readonly<Record<string, { iconPath: string }>> = manifest.iconDefinitions;

function getAssociation(associations: Associations, name: string) {
  return Object.hasOwn(associations, name) ? associations[name] : undefined;
}

function normalizePath(path: string) {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function iconFiles(icon: string, lightIcon?: string) {
  const dark = definitions[icon]?.iconPath.split('/').at(-1);
  const light = lightIcon && definitions[lightIcon]?.iconPath.split('/').at(-1);
  return { dark, light: light || dark };
}

function pathIcon(path: string, associations: Associations, lightAssociations: Associations) {
  let start = 0;
  for (;;) {
    const candidate = path.slice(start);
    const icon = getAssociation(associations, candidate);
    if (icon) return iconFiles(icon, getAssociation(lightAssociations, candidate));
    const separator = path.indexOf('/', start);
    if (separator === -1) return undefined;
    start = separator + 1;
  }
}

export function fileTreeFileIcon(path: string) {
  const normalized = normalizePath(path);
  const named = pathIcon(normalized, manifest.fileNames, manifest.light.fileNames);
  if (named) return named;

  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
    const extension = name.slice(dot + 1);
    const icon = getAssociation(manifest.fileExtensions, extension);
    if (icon) return iconFiles(icon, getAssociation(manifest.light.fileExtensions, extension));
  }

  return iconFiles(manifest.file);
}

export function fileTreeFolderIcon(path: string, open: boolean) {
  const folders = open ? manifest.folderNamesExpanded : manifest.folderNames;
  const lightFolders = open ? manifest.light.folderNamesExpanded : manifest.light.folderNames;
  return (
    pathIcon(normalizePath(path), folders, lightFolders) ??
    iconFiles(open ? manifest.folderExpanded : manifest.folder)
  );
}
