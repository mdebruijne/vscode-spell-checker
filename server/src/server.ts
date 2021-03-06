// cSpell:ignore pycache

import {
    IPCMessageReader, IPCMessageWriter,
    createConnection, IConnection,
    TextDocuments, TextDocument,
    InitializeResult,
    InitializeParams
} from 'vscode-languageserver';
import { CancellationToken } from 'vscode-jsonrpc';
import * as Validator from './validator';
import * as Rx from 'rx';
import { onCodeActionHandler } from './codeActions';
import {
    ExcludeFilesGlobMap,
    ExclusionFunction,
    extractGlobsFromExcludeFilesGlobMap,
    generateExclusionFunctionForUri,
    Glob
} from './exclusionHelper';
import * as path from 'path';

import * as CSpellSettings from './CSpellSettingsServer';
import { CSpellPackageSettings } from './CSpellSettingsDef';
import { getDefaultSettings } from './DefaultSettings';
import * as tds from './TextDocumentSettings';


const defaultSettings = getDefaultSettings();
const settings: CSpellPackageSettings = {...defaultSettings};

const defaultExclude: Glob[] = [
    'debug:*',
    'debug:/**',        // Files that are generated while debugging (generally from a .map file)
    'vscode:/**',       // VS Code generated files (settings.json for example)
    'private:/**',
    'markdown:/**',     // The HTML generated by the markdown previewer
    'git-index:/**',    // Ignore files loaded for git indexing
    '**/*.rendered',
    '**/*.*.rendered',
    '__pycache__/**',   // ignore cache files.
];

// The settings interface describe the server relevant settings part
interface Settings {
    cSpell?: CSpellPackageSettings;
    search?: {
        exclude?: ExcludeFilesGlobMap;
    };
}

interface VsCodeSettings {
    [key: string]: any;
}

let fnFileExclusionTest: ExclusionFunction = () => false;

function run() {
    // debounce buffer
    const validationRequestStream: Rx.ReplaySubject<TextDocument> = new Rx.ReplaySubject<TextDocument>(1);
    const validationFinishedStream: Rx.ReplaySubject<{ uri: string; version: number }> =
        new Rx.ReplaySubject<{ uri: string; version: number }>(1);

    // Create a connection for the server. The connection uses Node's IPC as a transport
    const connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

    // Create a simple text document manager. The text document manager
    // supports full document sync only
    const documents: TextDocuments = new TextDocuments();

    // After the server has started the client sends an initialize request. The server receives
    // in the passed params the rootPath of the workspace plus the client capabilities.
    let workspaceRoot: string;
    connection.onInitialize((params: InitializeParams, token: CancellationToken): InitializeResult => {
        workspaceRoot = params.rootPath;
        return {
            capabilities: {
                // Tell the client that the server works in FULL text document sync mode
                textDocumentSync: documents.syncKind,
                codeActionProvider: true
            }
        };
    });

    // The settings have changed. Is sent on server activation as well.
    connection.onDidChangeConfiguration(onConfigChange);

    function onConfigChange(change) {
        const configPaths = workspaceRoot ? [
            path.join(workspaceRoot, '.vscode', CSpellSettings.defaultFileName.toLowerCase()),
            path.join(workspaceRoot, '.vscode', CSpellSettings.defaultFileName),
            path.join(workspaceRoot, CSpellSettings.defaultFileName.toLowerCase()),
            path.join(workspaceRoot, CSpellSettings.defaultFileName),
        ] : [];
        const cSpellSettingsFile = CSpellSettings.readSettingsFiles(configPaths);
        const { cSpell = {}, search = {} } = change.settings as Settings;
        const { exclude = {} } = search;
        const mergedSettings = CSpellSettings.mergeSettings(defaultSettings, cSpellSettingsFile, cSpell);
        const { ignorePaths = []} = mergedSettings;
        const globs = defaultExclude.concat(ignorePaths, extractGlobsFromExcludeFilesGlobMap(exclude));
        fnFileExclusionTest = generateExclusionFunctionForUri(globs, workspaceRoot);
        Object.assign(settings, mergedSettings);

        // Revalidate any open text documents
        documents.all().forEach(doc => validationRequestStream.onNext(doc));
    }

    interface TextDocumentInfo {
        uri?: string;
        languageId?: string;
    }

    // Listen for event messages from the client.
    connection.onNotification({ method: 'applySettings'}, onConfigChange);

    connection.onRequest({ method: 'isSpellCheckEnabled' }, (params: TextDocumentInfo) => {
        const { uri, languageId } = params;
        return {
            languageEnabled: languageId ? isLanguageEnabled(languageId) : undefined,
            fileEnabled: uri ? !isUriExcluded(uri) : undefined,
        };
    });

    connection.onRequest({ method: 'getConfigurationForDocument' }, (params: TextDocumentInfo) => {
        const { uri, languageId } = params;
        const doc = uri && documents.get(uri);
        const docSettings = doc && getSettingsToUseForDocument(doc);
        const settings = getBaseSettings();
        return {
            languageEnabled: languageId ? isLanguageEnabled(languageId) : undefined,
            fileEnabled: uri ? !isUriExcluded(uri) : undefined,
        };
    });


    // validate documents
    const disposeValidationStream = validationRequestStream
        // .tap(doc => connection.console.log(`A Validate ${doc.uri}:${doc.version}:${Date.now()}`))
        .filter(shouldValidateDocument)
        // .tap(doc => connection.console.log(`B Validate ${doc.uri}:${doc.version}:${Date.now()}`))
        // De-dupe and backed up request by waiting for 50ms.
        .groupByUntil(doc => doc.uri, doc => doc, function () {
            return Rx.Observable.timer(settings.spellCheckDelayMs || 50);
        })
        // keep only the last request in a group.
        .flatMap(group => group.last())
        // .tap(doc => connection.console.log(`C Validate ${doc.uri}:${doc.version}:${Date.now()}`))
        .subscribe(validateTextDocument);

    // Clear the diagnostics for documents we do not want to validate
    const disposableSkipValidationStream = validationRequestStream
        .filter(doc => !shouldValidateDocument(doc))
        .subscribe(doc => {
            connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
        });

    validationFinishedStream.onNext({ uri: 'start', version: 0 });

    function shouldValidateDocument(textDocument: TextDocument): boolean {
        const { uri, languageId } = textDocument;
        return !!settings.enabled && isLanguageEnabled(languageId)
            && !isUriExcluded(uri);
    }

    function isLanguageEnabled(languageId: string) {
        const { enabledLanguageIds = []} = settings;
        return enabledLanguageIds.indexOf(languageId) >= 0;
    }

    function isUriExcluded(uri: string) {
        return fnFileExclusionTest(uri);
    }

    function getBaseSettings() {
        return {...CSpellSettings.mergeSettings(defaultSettings, settings), enabledLanguageIds: settings.enabledLanguageIds};
    }

    function getSettingsToUseForDocument(doc: TextDocument) {
        return tds.getSettings(getBaseSettings(), doc.getText(), doc.languageId);
    }

    function validateTextDocument(textDocument: TextDocument): void {
        try {
            const settingsToUse = getSettingsToUseForDocument(textDocument);

            Validator.validateTextDocument(textDocument, settingsToUse).then(diagnostics => {
                // Send the computed diagnostics to VSCode.
                validationFinishedStream.onNext(textDocument);
                connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
            });
        } catch (e) {
            console.log(e);
        }
    }

    // Make the text document manager listen on the connection
    // for open, change and close text document events
    documents.listen(connection);

    // The content of a text document has changed. This event is emitted
    // when the text document first opened or when its content has changed.
    documents.onDidChangeContent((change) => {
        validationRequestStream.onNext(change.document);
    });

    documents.onDidClose((event) => {
        // A text document was closed we clear the diagnostics
        connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
    });

    connection.onCodeAction(onCodeActionHandler(documents, getBaseSettings));

    // Listen on the connection
    connection.listen();

    // Free up the validation streams on shutdown.
    connection.onShutdown(() => {
        disposableSkipValidationStream.dispose();
        disposeValidationStream.dispose();
    });
}

run();