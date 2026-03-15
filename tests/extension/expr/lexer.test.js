import { tokenize, TokenType } from '../../../src/extension/expr/lexer.js';

export function run(assert) {
    // --- Numeric literals ---
    {
        const tokens = tokenize('3');
        assert(tokens.length === 2, 'integer: 2 tokens (NUMBER + EOF)');
        assert(tokens[0].type === TokenType.NUMBER, 'integer: type NUMBER');
        assert(tokens[0].value === 3, 'integer: value 3');
    }
    {
        const tokens = tokenize('3.14');
        assert(tokens[0].type === TokenType.NUMBER, 'float: type NUMBER');
        assert(Math.abs(tokens[0].value - 3.14) < 1e-10, 'float: value 3.14');
    }
    {
        const tokens = tokenize('.5');
        assert(tokens[0].type === TokenType.NUMBER, 'leading dot: type NUMBER');
        assert(Math.abs(tokens[0].value - 0.5) < 1e-10, 'leading dot: value 0.5');
    }
    {
        const tokens = tokenize('1e3');
        assert(tokens[0].type === TokenType.NUMBER, 'scientific: type NUMBER');
        assert(tokens[0].value === 1000, 'scientific: value 1000');
    }
    {
        const tokens = tokenize('1.5e-2');
        assert(tokens[0].type === TokenType.NUMBER, 'sci negative exp: type NUMBER');
        assert(Math.abs(tokens[0].value - 0.015) < 1e-10, 'sci negative exp: value 0.015');
    }
    {
        const tokens = tokenize('2.5E+3');
        assert(tokens[0].type === TokenType.NUMBER, 'sci uppercase E+: type NUMBER');
        assert(tokens[0].value === 2500, 'sci uppercase E+: value 2500');
    }

    // --- Identifiers ---
    {
        const tokens = tokenize('zoom');
        assert(tokens[0].type === TokenType.IDENT, 'ident: type IDENT');
        assert(tokens[0].value === 'zoom', 'ident: value zoom');
    }
    {
        const tokens = tokenize('q1');
        assert(tokens[0].type === TokenType.IDENT, 'ident q1: type IDENT');
        assert(tokens[0].value === 'q1', 'ident q1: value q1');
    }
    {
        const tokens = tokenize('bass_att');
        assert(tokens[0].type === TokenType.IDENT, 'ident underscore: type IDENT');
        assert(tokens[0].value === 'bass_att', 'ident underscore: value bass_att');
    }
    {
        const tokens = tokenize('t8');
        assert(tokens[0].value === 't8', 'ident t8: value t8');
    }
    {
        const tokens = tokenize('_private');
        assert(tokens[0].type === TokenType.IDENT, 'ident leading underscore: type IDENT');
        assert(tokens[0].value === '_private', 'ident leading underscore: value');
    }

    // --- Function names are identifiers ---
    {
        const tokens = tokenize('sin');
        assert(tokens[0].type === TokenType.IDENT, 'sin is IDENT');
        assert(tokens[0].value === 'sin', 'sin value');
    }
    {
        const tokens = tokenize('atan2');
        assert(tokens[0].type === TokenType.IDENT, 'atan2 is IDENT');
    }

    // --- Operators ---
    {
        const tokens = tokenize('+ - * / % ^');
        assert(tokens[0].type === TokenType.OP && tokens[0].value === '+', 'op +');
        assert(tokens[1].type === TokenType.OP && tokens[1].value === '-', 'op -');
        assert(tokens[2].type === TokenType.OP && tokens[2].value === '*', 'op *');
        assert(tokens[3].type === TokenType.OP && tokens[3].value === '/', 'op /');
        assert(tokens[4].type === TokenType.OP && tokens[4].value === '%', 'op %');
        assert(tokens[5].type === TokenType.OP && tokens[5].value === '^', 'op ^');
    }

    // --- Structural tokens ---
    {
        const tokens = tokenize('( ) , ;');
        assert(tokens[0].type === TokenType.LPAREN, 'lparen');
        assert(tokens[1].type === TokenType.RPAREN, 'rparen');
        assert(tokens[2].type === TokenType.COMMA, 'comma');
        assert(tokens[3].type === TokenType.SEMI, 'semi');
    }

    // --- Assignment ---
    {
        const tokens = tokenize('x = 5');
        assert(tokens[0].type === TokenType.IDENT, 'assign: lhs ident');
        assert(tokens[1].type === TokenType.ASSIGN, 'assign: = token');
        assert(tokens[2].type === TokenType.NUMBER, 'assign: rhs number');
    }

    // --- Comparison operators ---
    {
        const tokens = tokenize('< > <= >= == !=');
        assert(tokens[0].type === TokenType.COMPARE && tokens[0].value === '<', 'cmp <');
        assert(tokens[1].type === TokenType.COMPARE && tokens[1].value === '>', 'cmp >');
        assert(tokens[2].type === TokenType.COMPARE && tokens[2].value === '<=', 'cmp <=');
        assert(tokens[3].type === TokenType.COMPARE && tokens[3].value === '>=', 'cmp >=');
        assert(tokens[4].type === TokenType.COMPARE && tokens[4].value === '==', 'cmp ==');
        assert(tokens[5].type === TokenType.COMPARE && tokens[5].value === '!=', 'cmp !=');
    }

    // --- Logic operators ---
    {
        const tokens = tokenize('& | !');
        assert(tokens[0].type === TokenType.LOGIC && tokens[0].value === '&', 'logic &');
        assert(tokens[1].type === TokenType.LOGIC && tokens[1].value === '|', 'logic |');
        assert(tokens[2].type === TokenType.LOGIC && tokens[2].value === '!', 'logic !');
    }

    // --- Multi-expression statement ---
    {
        const tokens = tokenize('x = sin(time); y = cos(time * 2.0);');
        const types = tokens.map(t => t.type);
        // x = sin ( time ) ; y = cos ( time * 2.0 ) ; EOF
        assert(types[0] === TokenType.IDENT, 'multi: x ident');
        assert(types[1] === TokenType.ASSIGN, 'multi: =');
        assert(types[2] === TokenType.IDENT, 'multi: sin ident');
        assert(types[3] === TokenType.LPAREN, 'multi: (');
        assert(types[4] === TokenType.IDENT, 'multi: time ident');
        assert(types[5] === TokenType.RPAREN, 'multi: )');
        assert(types[6] === TokenType.SEMI, 'multi: ;');
        assert(types[7] === TokenType.IDENT, 'multi: y ident');
        assert(types[types.length - 1] === TokenType.EOF, 'multi: final EOF');
    }

    // --- Edge: empty string ---
    {
        const tokens = tokenize('');
        assert(tokens.length === 1, 'empty: just EOF');
        assert(tokens[0].type === TokenType.EOF, 'empty: type EOF');
    }

    // --- Edge: whitespace-only ---
    {
        const tokens = tokenize('   \t\n  ');
        assert(tokens.length === 1, 'whitespace-only: just EOF');
        assert(tokens[0].type === TokenType.EOF, 'whitespace-only: type EOF');
    }

    // --- Edge: trailing semicolons ---
    {
        const tokens = tokenize('x = 1;;;');
        // x = 1 ; ; ; EOF — multiple semis are valid
        let semiCount = 0;
        for (const t of tokens) if (t.type === TokenType.SEMI) semiCount++;
        assert(semiCount === 3, 'trailing semicolons: 3 semi tokens');
    }

    // --- Negative number as unary minus ---
    {
        // Lexer should NOT produce negative numbers; -2.5 is OP(-) + NUMBER(2.5)
        const tokens = tokenize('-2.5');
        assert(tokens[0].type === TokenType.OP && tokens[0].value === '-', 'neg: minus op');
        assert(tokens[1].type === TokenType.NUMBER && tokens[1].value === 2.5, 'neg: positive number');
    }

    // --- Complex expression ---
    {
        const tokens = tokenize('zoom = zoom + 0.27 * sin(time * 1.55 + rad * 5)');
        assert(tokens[0].value === 'zoom', 'complex: first ident zoom');
        assert(tokens[tokens.length - 1].type === TokenType.EOF, 'complex: ends with EOF');
        // Count specific token types
        let identCount = 0, numCount = 0, opCount = 0;
        for (const t of tokens) {
            if (t.type === TokenType.IDENT) identCount++;
            if (t.type === TokenType.NUMBER) numCount++;
            if (t.type === TokenType.OP) opCount++;
        }
        // zoom, zoom, sin, time, rad = 5 idents
        assert(identCount === 5, 'complex: 5 identifiers');
        // 0.27, 1.55, 5 = 3 numbers
        assert(numCount === 3, 'complex: 3 numbers');
        // +, *, *, +, * = 5 ops
        assert(opCount === 5, 'complex: 5 operators');
    }

    // --- Token position tracking ---
    {
        const tokens = tokenize('x = 1');
        assert(tokens[0].pos === 0, 'pos: x at 0');
        assert(tokens[1].pos === 2, 'pos: = at 2');
        assert(tokens[2].pos === 4, 'pos: 1 at 4');
    }

    // --- Unknown character produces error token ---
    {
        const tokens = tokenize('x @ y');
        const hasError = tokens.some(t => t.type === TokenType.ERROR);
        assert(hasError, 'unknown char @ produces ERROR token');
    }
}
