import contract from './desktop-contract.cjs';
export const { commandDefinitions, validateCommand, validatePreview, desktopError } = contract;
/** @typedef {import('./desktop-contract.cjs').CommandName} CommandName */
/** @typedef {import('./desktop-contract.cjs').DesktopError} DesktopError */
/** @template T @typedef {import('./desktop-contract.cjs').DesktopResult<T>} DesktopResult */
/** @template {CommandName} N @typedef {import('./desktop-contract.cjs').CommandParams<N>} CommandParams */
/** @typedef {import('./desktop-contract.cjs').PreviewRequest} PreviewRequest */
/** @typedef {import('./desktop-contract.cjs').OwnedPreviewOperation} OwnedPreviewOperation */
