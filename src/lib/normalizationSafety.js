// Conservative, deterministic review policy; not a general semantic parser.
const units = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const tens = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
const hindi = new Map([["शून्य", 0], ["एक", 1], ["दो", 2], ["तीन", 3], ["चार", 4], ["पाँच", 5], ["पांच", 5], ["छह", 6], ["सात", 7], ["आठ", 8], ["नौ", 9], ["दस", 10], ["बीस", 20], ["पच्चीस", 25], ["सौ", 100]]);
const wordValue = word => units.indexOf(word);
const tokenPattern = /[\p{L}\p{M}\p{N}]+(?:[.,:-][\p{L}\p{M}\p{N}]+)*|[^\s]/gu;
const numeric = token => /^\p{N}+(?:[.,:-]\p{N}+)*(?:st|nd|rd|th)?$/u.test(token);
const spoken = token => token.toLowerCase().split("-").every(word => units.includes(word) || tens.includes(word) || ["hundred", "thousand", "million", "billion", "trillion", "lakh", "crore", "oh", "o", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "twentieth", "thirtieth", "fortieth", "fiftieth"].includes(word) || hindi.has(word));

function integer(words, ceiling = Infinity) {
    if (!words.length) return null;
    for (const [scale, value] of [["trillion", 1e12], ["billion", 1e9], ["million", 1e6], ["crore", 1e7], ["lakh", 1e5], ["thousand", 1000]]) {
        if (value >= ceiling) continue;
        const at = words.indexOf(scale);
        if (at < 0) continue;
        const left = integer(words.slice(0, at), value);
        const rest = words.slice(at + 1);
        const right = rest.length ? integer(rest, value) : 0;
        const result = left * value + right;
        return left > 0 && right !== null && Number.isSafeInteger(result) ? result : null;
    }
    const hundred = words.indexOf("hundred");
    if (hundred >= 0) {
        if (hundred !== 1 || wordValue(words[0]) < 1 || wordValue(words[0]) > 9) return null;
        const rest = words.slice(2);
        if (rest[0] === "and") rest.shift();
        const tail = rest.length ? small(rest) : 0;
        return tail === null ? null : wordValue(words[0]) * 100 + tail;
    }
    // Common unambiguous year form: two thousand twenty six is handled above.
    return small(words);
}
function small(words) {
    if (words.length === 1 && wordValue(words[0]) >= 0) return wordValue(words[0]);
    const ten = tens.indexOf(words[0]);
    if (ten < 0) return null;
    if (words.length === 1) return (ten + 2) * 10;
    const unit = wordValue(words[1]);
    return words.length === 2 && unit > 0 && unit < 10 ? (ten + 2) * 10 + unit : null;
}
function expectedNumber(text) {
    const lower = text.toLowerCase().trim();
    if (hindi.has(lower)) return String(hindi.get(lower));
    const words = lower.split(/[\s-]+/);
    const point = words.indexOf("point");
    const whole = integer(point < 0 ? words : words.slice(0, point));
    if (whole === null) return null;
    if (point < 0) return String(whole);
    const fraction = words.slice(point + 1);
    if (!fraction.length || fraction.some(word => wordValue(word) < 0 || wordValue(word) > 9)) return null;
    return `${whole}.${fraction.map(wordValue).join("")}`;
}
function parts(text) {
    const tokens = [...text.matchAll(tokenPattern)].map(match => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
    const isNumber = token => token && (numeric(token.text) || spoken(token.text));
    const isConnector = (token, index) => ["and", "point", "decimal", "और", "दशमलव"].includes(token.text.toLowerCase()) && isNumber(tokens[index - 1]) && isNumber(tokens[index + 1]);
    const result = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const number = Boolean(isNumber(token) || isConnector(token, i));
        const previous = result.at(-1);
        if (number && previous?.number && /^\s*$/.test(text.slice(previous.end, token.start))) {
            previous.end = token.end;
            previous.text = text.slice(previous.start, previous.end);
        } else result.push({ ...token, number });
    }
    return result;
}
const review = (original, reason) => ({ text: original, reviewReasons: [reason] });
export const NORMALIZATION_REVIEW_REASONS = Object.freeze(["ambiguous-context", "uncertain-number", "line-spanning-number", "numeric-value-mismatch"]);

export function preserveNormalization(original, proposed) {
    // This is a cue-wide hold, including unchanged provider proposals: dates and
    // contact/code contexts deserve a visible review flag even without a rewrite.
    const ambiguous = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|date|birthday|phone|telephone|tel|call|dial|digits?|sequence|identifier|id|reference|ref|account|code|pin|otp|serial|version)\b|(?:तारीख|फ़ोन|फोन|खाता|कोड|नंबर)/iu.test(original) || /\b(?:one of|one another|second to|first class|two to|three to)\b/i.test(original) || /\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/.test(original) || /\b[A-Z]{2,}[- ]+(?:zero|one|two|three|four|five|six|seven|eight|nine|twenty)\b/.test(original);
    if (ambiguous) return review(original, "ambiguous-context");
    const before = parts(original);
    if (/\b0\d{2,}\b|\b\d{3}[- ]\d{3}[- ]\d{4}\b/.test(original)) return review(original, "ambiguous-context");
    if (original === proposed) {
        const uncertain = before.some(part => part.number && !/\p{N}/u.test(part.text) && expectedNumber(part.text) === null);
        return uncertain ? review(original, "uncertain-number") : { text: original, reviewReasons: [] };
    }
    const after = parts(proposed);
    if (before.length !== after.length || before.some((part, i) => part.number !== after[i].number || (!part.number && part.text !== after[i].text))) return review(original, "uncertain-number");
    const changes = before.flatMap((part, i) => part.number && part.text !== after[i].text ? [{ ...part, output: after[i].text }] : []);
    if (!changes.length) return { text: original, reviewReasons: [] };
    // Cue-wide retention is intentional: do not partially interpret a date, code,
    // contact detail or idiom. Users can explicitly edit the retained proposal.
    for (const change of changes) {
        if (/[\r\n]/.test(change.text)) return review(original, "line-spanning-number");
        // Existing numeric literals are never replacement targets. A mixed span
        // is retained rather than guessing how its literal and words combine.
        if (/\p{N}/u.test(change.text)) return review(original, "uncertain-number");
        const expected = expectedNumber(change.text);
        if (expected === null) return review(original, "uncertain-number");
        if (change.output !== expected) return review(original, "numeric-value-mismatch");
    }
    // Only replace verified spans in the ORIGINAL string. Every other byte,
    // including LF/CRLF, blank lines, indentation and punctuation, survives.
    let text = original;
    for (const change of changes.toReversed()) text = text.slice(0, change.start) + change.output + text.slice(change.end);
    return { text, reviewReasons: [] };
}
