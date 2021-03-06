// cSpell:enableCompoundWords
import * as Rx from 'rx';
import * as Text from './util/text';
import { lineReader } from './util/fileReader';
import * as XRegExp from 'xregexp';


const regExpWordsWithSpaces = XRegExp('^\\s*\\p{L}+(?:\\s+\\p{L}+){0,3}$');

export interface WordDictionary {
    [index: string]: boolean;
}

export type WordSet = Set<string>;

export function loadWordsRx(filename: string): Rx.Observable<string> {
    return lineReader(filename).tapOnError(logError).catch(Rx.Observable.fromArray<string>([]));
}

function logError(e: any) {
    console.log(e);
}

export function splitLine(line: string) {
    return Text.extractWordsFromText(line).map(({word}) => word).toArray();
}

export function splitCodeWords(words: string[]) {
    return words
        .map(Text.splitCamelCaseWord)
        .reduce((a, b) => a.concat(b), []);
}

export function splitLineIntoCodeWordsRx(line: string) {
    const asMultiWord = regExpWordsWithSpaces.test(line) ? [ line ] : [];
    const asWords = splitLine(line);
    const splitWords = splitCodeWords(asWords);
    const wordsToAdd = [...asMultiWord, ...asWords, ...splitWords];
    return Rx.Observable.fromArray(wordsToAdd);
}

export function splitLineIntoWordsRx(line: string) {
    const asWords = splitLine(line);
    const wordsToAdd = [line, ...asWords];
    return Rx.Observable.fromArray(wordsToAdd);
}

/**
 * @deprecated
 */
export function processWordListLinesRx(lines: Rx.Observable<string>, minWordLength: number) {
    return processWordsRx(
        lines.flatMap(splitLineIntoCodeWordsRx)
    );
}


/**
 * @deprecated
 */
export function processWordsRx(lines: Rx.Observable<string>) {
    return lines
        .map(word => word.trim().toLowerCase())
        .scan((acc: { setOfWords: Set<string>; found: boolean; word: string; }, word: string) => {
            const { setOfWords } = acc;
            const found = setOfWords.has(word);
            if (!found) {
                setOfWords.add(word);
            }
            return { found, word, setOfWords };
        }, { setOfWords: (new Set<string>()).add(''), found: false, word: '' })
        .filter(({found}) => !found)
    ;
}


/**
 * @deprecated
 */
export function processCodeWordsRx(entries: Rx.Observable<string>, minWordLength: number) {
    return entries
        .flatMap(line => Rx.Observable.concat(
            // Add the line
            Rx.Observable.just(line),
            // Add the individual words in the line
            Text.extractWordsFromTextRx(line)
                .map(({word}) => word)
                .filter(word => word.length > minWordLength),
            // Add the individual words split by camel case
            Text.extractWordsFromTextRx(line)
                .flatMap(Text.splitCamelCaseWordWithOffsetRx)
                .map(({word}) => word)
                .filter(word => word.length > minWordLength)
        ));
}



export function rxSplitIntoWords(lines: Rx.Observable<string>): Rx.Observable<string> {
    return lines.flatMap(line =>
        Text.extractWordsFromTextRx(line)
            .map(match => match.word)
            .map(w => w.trim())
            .filter(w => w !== '')
    );
}


export function rxSplitCamelCaseWords(words: Rx.Observable<string>): Rx.Observable<string> {
    return words.flatMap(word => Text.splitCamelCaseWord(word));
}



export function processWordsOld(lines: Rx.Observable<string>) {
    return lines
        .map(word => word.trim())
        .scan((pair: { setOfWords: WordDictionary; found: boolean; word: string; }, word: string) => {
            const { setOfWords } = pair;
            const found = setOfWords[word] === true;
            setOfWords[word] = true;
            return { found , word, setOfWords };
        }, { setOfWords: Object.create(null), found: false, word: '' })
        .filter(({found}) => !found);
}


