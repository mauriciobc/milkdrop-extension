/**
 * MilkDrop 2 expression language parser.
 * Pratt parser (precedence climbing) producing an AST.
 * Pure JS — no GI imports.
 */

import { tokenize, TokenType } from './lexer.js';

export const NodeType = Object.freeze({
    PROGRAM:   'PROGRAM',
    LITERAL:   'LITERAL',
    IDENT:     'IDENT',
    ASSIGN:    'ASSIGN',
    MEMASSIGN: 'MEMASSIGN',
    BINOP:     'BINOP',
    UNARYOP:   'UNARYOP',
    CALL:      'CALL',
});

// Binding powers (precedence). Higher = tighter binding.
const BP_NONE    = 0;
const BP_ASSIGN  = 1;   // =
const BP_LOGIC_OR = 2;  // |
const BP_LOGIC_AND = 3; // &
const BP_CMP     = 4;   // == != < > <= >=
const BP_ADD     = 5;   // + -
const BP_MUL     = 6;   // * / %
const BP_POW     = 7;   // ^
const BP_UNARY   = 8;   // - !
const BP_CALL    = 9;   // f(...)

function infixBP(token) {
    if (token.type === TokenType.ASSIGN) return BP_ASSIGN;
    if (token.type === TokenType.LOGIC) {
        if (token.value === '|') return BP_LOGIC_OR;
        if (token.value === '&') return BP_LOGIC_AND;
    }
    if (token.type === TokenType.COMPARE) return BP_CMP;
    if (token.type === TokenType.OP) {
        switch (token.value) {
            case '+': case '-': return BP_ADD;
            case '*': case '/': case '%': return BP_MUL;
            case '^': return BP_POW;
        }
    }
    return BP_NONE;
}

function isRightAssoc(token) {
    return (token.type === TokenType.OP && token.value === '^') ||
           token.type === TokenType.ASSIGN;
}

/**
 * Parse a MilkDrop expression string into an AST.
 * @param {string} src
 * @returns {{ type: 'PROGRAM', body: Array }}
 */
export function parse(src) {
    const tokens = tokenize(src);
    let pos = 0;

    function peek() { return tokens[pos]; }
    function advance() { return tokens[pos++]; }
    function expect(type) {
        const t = advance();
        if (t.type !== type) throw new Error(`Expected ${type}, got ${t.type} at pos ${t.pos}`);
        return t;
    }

    // Prefix (nud)
    function nud(token) {
        switch (token.type) {
            case TokenType.NUMBER:
                return { type: NodeType.LITERAL, value: token.value };
            case TokenType.IDENT: {
                // Could be a function call: ident(...)
                if (peek().type === TokenType.LPAREN) {
                    advance(); // consume (
                    const args = [];
                    if (peek().type !== TokenType.RPAREN) {
                        args.push(expr(BP_NONE));
                        while (peek().type === TokenType.COMMA) {
                            advance(); // consume ,
                            args.push(expr(BP_NONE));
                        }
                    }
                    expect(TokenType.RPAREN);
                    return { type: NodeType.CALL, name: token.value, args };
                }
                return { type: NodeType.IDENT, name: token.value };
            }
            case TokenType.LPAREN: {
                const inner = expr(BP_NONE);
                expect(TokenType.RPAREN);
                return inner;
            }
            case TokenType.OP:
                if (token.value === '-' || token.value === '+') {
                    return { type: NodeType.UNARYOP, op: token.value, operand: expr(BP_UNARY) };
                }
                throw new Error(`Unexpected prefix op '${token.value}' at pos ${token.pos}`);
            case TokenType.LOGIC:
                if (token.value === '!') {
                    return { type: NodeType.UNARYOP, op: '!', operand: expr(BP_UNARY) };
                }
                throw new Error(`Unexpected token '${token.value}' at pos ${token.pos}`);
            default:
                throw new Error(`Unexpected token type ${token.type} at pos ${token.pos}`);
        }
    }

    // Infix (led)
    function led(left, token) {
        const bp = infixBP(token);
        const rbp = isRightAssoc(token) ? bp - 1 : bp;

        // Assignment: ident = expr  or  megabuf(i) = expr
        if (token.type === TokenType.ASSIGN) {
            if (left.type === NodeType.IDENT) {
                return { type: NodeType.ASSIGN, name: left.name, value: expr(rbp) };
            }
            if (left.type === NodeType.CALL &&
                (left.name === 'megabuf' || left.name === 'gmegabuf')) {
                if (!Array.isArray(left.args) || left.args.length !== 1) {
                    throw new Error(`megabuf/gmegabuf requires exactly one index argument`);
                }
                return { type: NodeType.MEMASSIGN, buf: left.name, index: left.args[0], value: expr(rbp) };
            }
            throw new Error('Assignment target must be identifier or megabuf/gmegabuf');
        }

        // Binary operator
        const right = expr(rbp);
        const op = token.value;
        return { type: NodeType.BINOP, op, left, right };
    }

    function expr(minBP) {
        let left = nud(advance());

        while (true) {
            const t = peek();
            if (t.type === TokenType.EOF || t.type === TokenType.SEMI ||
                t.type === TokenType.RPAREN || t.type === TokenType.COMMA) break;

            const bp = infixBP(t);
            if (bp <= minBP) break;

            advance();
            left = led(left, t);
        }

        return left;
    }

    function program() {
        const stmts = [];
        while (peek().type !== TokenType.EOF) {
            // Skip empty semicolons
            if (peek().type === TokenType.SEMI) { advance(); continue; }
            stmts.push(expr(BP_NONE));
            // Consume optional semicolons between statements
            while (peek().type === TokenType.SEMI) advance();
        }
        return { type: NodeType.PROGRAM, body: stmts };
    }

    return program();
}
