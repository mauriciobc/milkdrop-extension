/**
 * MilkDrop 2 expression language lexer (tokenizer).
 * Pure JS — no GI imports. Runs under gjs -m.
 */

export const TokenType = Object.freeze({
    NUMBER:  'NUMBER',
    IDENT:   'IDENT',
    OP:      'OP',
    LPAREN:  'LPAREN',
    RPAREN:  'RPAREN',
    COMMA:   'COMMA',
    SEMI:    'SEMI',
    ASSIGN:  'ASSIGN',
    COMPARE: 'COMPARE',
    LOGIC:   'LOGIC',
    EOF:     'EOF',
    ERROR:   'ERROR',
});

function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isAlpha(ch) { return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'; }
function isAlphaNum(ch) { return isAlpha(ch) || isDigit(ch); }
function isWhitespace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'; }

/**
 * Tokenize a MilkDrop expression string.
 * @param {string} src
 * @returns {Array<{type: string, value: *, pos: number}>}
 */
export function tokenize(src) {
    const tokens = [];
    let i = 0;
    const len = src.length;

    while (i < len) {
        const ch = src[i];

        // Skip whitespace
        if (isWhitespace(ch)) { i++; continue; }

        // Line comment: // ... to end of line
        if (ch === '/' && i + 1 < len && src[i + 1] === '/') {
            i += 2;
            while (i < len && src[i] !== '\n') i++;
            continue;
        }

        // Block comment: /* ... */
        if (ch === '/' && i + 1 < len && src[i + 1] === '*') {
            i += 2;
            while (i + 1 < len && (src[i] !== '*' || src[i + 1] !== '/')) i++;
            if (i + 1 < len) i += 2;
            continue;
        }

        // Numbers: digits or leading dot followed by digit
        if (isDigit(ch) || (ch === '.' && i + 1 < len && isDigit(src[i + 1]))) {
            const start = i;
            // Integer part
            while (i < len && isDigit(src[i])) i++;
            // Fractional part
            if (i < len && src[i] === '.') {
                i++;
                while (i < len && isDigit(src[i])) i++;
            }
            // Exponent part
            if (i < len && (src[i] === 'e' || src[i] === 'E')) {
                i++;
                if (i < len && (src[i] === '+' || src[i] === '-')) i++;
                while (i < len && isDigit(src[i])) i++;
            }
            tokens.push({ type: TokenType.NUMBER, value: parseFloat(src.slice(start, i)), pos: start });
            continue;
        }

        // Identifiers
        if (isAlpha(ch)) {
            const start = i;
            while (i < len && isAlphaNum(src[i])) i++;
            tokens.push({ type: TokenType.IDENT, value: src.slice(start, i), pos: start });
            continue;
        }

        // Two-character comparison operators
        if (i + 1 < len) {
            const two = src[i] + src[i + 1];
            if (two === '<=' || two === '>=' || two === '==' || two === '!=') {
                tokens.push({ type: TokenType.COMPARE, value: two, pos: i });
                i += 2;
                continue;
            }
        }

        // Single-character tokens
        switch (ch) {
            case '(': tokens.push({ type: TokenType.LPAREN, value: '(', pos: i }); i++; continue;
            case ')': tokens.push({ type: TokenType.RPAREN, value: ')', pos: i }); i++; continue;
            case ',': tokens.push({ type: TokenType.COMMA, value: ',', pos: i }); i++; continue;
            case ';': tokens.push({ type: TokenType.SEMI, value: ';', pos: i }); i++; continue;
            case '+': case '-': case '*': case '/': case '%': case '^':
                tokens.push({ type: TokenType.OP, value: ch, pos: i }); i++; continue;
            case '=':
                tokens.push({ type: TokenType.ASSIGN, value: '=', pos: i }); i++; continue;
            case '<': case '>':
                tokens.push({ type: TokenType.COMPARE, value: ch, pos: i }); i++; continue;
            case '&': case '|': case '!':
                tokens.push({ type: TokenType.LOGIC, value: ch, pos: i }); i++; continue;
            default:
                tokens.push({ type: TokenType.ERROR, value: ch, pos: i }); i++; continue;
        }
    }

    tokens.push({ type: TokenType.EOF, value: null, pos: i });
    return tokens;
}
