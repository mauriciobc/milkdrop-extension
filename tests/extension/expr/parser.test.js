import { parse, NodeType } from '../../../src/extension/expr/parser.js';

export function run(assert) {
    // Helper: parse and return the program body
    function body(src) { return parse(src).body; }
    function first(src) { return body(src)[0]; }

    // --- Simple literal ---
    {
        const node = first('5');
        assert(node.type === NodeType.LITERAL, 'literal: type');
        assert(node.value === 5, 'literal: value 5');
    }

    // --- Simple identifier ---
    {
        const node = first('zoom');
        assert(node.type === NodeType.IDENT, 'ident: type');
        assert(node.name === 'zoom', 'ident: name zoom');
    }

    // --- Simple assignment ---
    {
        const node = first('x = 5');
        assert(node.type === NodeType.ASSIGN, 'assign: type');
        assert(node.name === 'x', 'assign: lhs name');
        assert(node.value.type === NodeType.LITERAL, 'assign: rhs is literal');
        assert(node.value.value === 5, 'assign: rhs value');
    }

    // --- Binary ops with precedence: a + b * c ---
    {
        const node = first('a + b * c');
        assert(node.type === NodeType.BINOP, 'precedence: top is BINOP');
        assert(node.op === '+', 'precedence: top op is +');
        assert(node.left.type === NodeType.IDENT && node.left.name === 'a', 'precedence: left is a');
        assert(node.right.type === NodeType.BINOP && node.right.op === '*', 'precedence: right is *');
        assert(node.right.left.name === 'b', 'precedence: right.left is b');
        assert(node.right.right.name === 'c', 'precedence: right.right is c');
    }

    // --- Parentheses override precedence ---
    {
        const node = first('(a + b) * c');
        assert(node.type === NodeType.BINOP, 'parens: top is BINOP');
        assert(node.op === '*', 'parens: top op is *');
        assert(node.left.type === NodeType.BINOP && node.left.op === '+', 'parens: left is +');
    }

    // --- Unary negation ---
    {
        const node = first('-x');
        assert(node.type === NodeType.UNARYOP, 'unary neg: type');
        assert(node.op === '-', 'unary neg: op');
        assert(node.operand.type === NodeType.IDENT && node.operand.name === 'x', 'unary neg: operand');
    }
    {
        const node = first('-(a + b)');
        assert(node.type === NodeType.UNARYOP, 'unary neg group: type');
        assert(node.operand.type === NodeType.BINOP, 'unary neg group: operand is BINOP');
    }

    // --- Logical NOT ---
    {
        const node = first('!x');
        assert(node.type === NodeType.UNARYOP, 'unary not: type');
        assert(node.op === '!', 'unary not: op');
    }

    // --- Function call with 1 arg ---
    {
        const node = first('sin(x)');
        assert(node.type === NodeType.CALL, 'call 1 arg: type');
        assert(node.name === 'sin', 'call 1 arg: name sin');
        assert(node.args.length === 1, 'call 1 arg: 1 argument');
        assert(node.args[0].type === NodeType.IDENT, 'call 1 arg: arg is ident');
    }

    // --- Function call with 2 args ---
    {
        const node = first('atan2(y, x)');
        assert(node.type === NodeType.CALL, 'call 2 args: type');
        assert(node.name === 'atan2', 'call 2 args: name');
        assert(node.args.length === 2, 'call 2 args: 2 arguments');
    }

    // --- Nested function calls ---
    {
        const node = first('if(above(x, 0), 1, -1)');
        assert(node.type === NodeType.CALL, 'nested call: type');
        assert(node.name === 'if', 'nested call: name if');
        assert(node.args.length === 3, 'nested call: 3 args');
        assert(node.args[0].type === NodeType.CALL && node.args[0].name === 'above', 'nested call: first arg is call');
    }

    // --- Chained expressions (semicolons) ---
    {
        const stmts = body('a = 1; b = a + 2;');
        assert(stmts.length === 2, 'chained: 2 statements');
        assert(stmts[0].type === NodeType.ASSIGN && stmts[0].name === 'a', 'chained: first is a = 1');
        assert(stmts[1].type === NodeType.ASSIGN && stmts[1].name === 'b', 'chained: second is b = a + 2');
    }

    // --- Chained without trailing semi ---
    {
        const stmts = body('a = 1; b = 2');
        assert(stmts.length === 2, 'chained no trail: 2 statements');
    }

    // --- Power right-associativity: 2^3^2 → Pow(2, Pow(3, 2)) ---
    {
        const node = first('2 ^ 3 ^ 2');
        assert(node.type === NodeType.BINOP && node.op === '^', 'pow assoc: top is ^');
        assert(node.left.type === NodeType.LITERAL && node.left.value === 2, 'pow assoc: left is 2');
        assert(node.right.type === NodeType.BINOP && node.right.op === '^', 'pow assoc: right is ^');
        assert(node.right.left.value === 3, 'pow assoc: right.left is 3');
        assert(node.right.right.value === 2, 'pow assoc: right.right is 2');
    }

    // --- Comparison operators ---
    {
        const node = first('x == 5');
        assert(node.type === NodeType.BINOP, 'cmp ==: type');
        assert(node.op === '==', 'cmp ==: op');
    }
    {
        const node = first('x != 0');
        assert(node.type === NodeType.BINOP && node.op === '!=', 'cmp !=');
    }
    {
        const node = first('a < b');
        assert(node.type === NodeType.BINOP && node.op === '<', 'cmp <');
    }
    {
        const node = first('a >= b');
        assert(node.type === NodeType.BINOP && node.op === '>=', 'cmp >=');
    }

    // --- Logic operators ---
    {
        const node = first('a & b');
        assert(node.type === NodeType.BINOP && node.op === '&', 'logic &');
    }
    {
        const node = first('a | b');
        assert(node.type === NodeType.BINOP && node.op === '|', 'logic |');
    }

    // --- Precedence: logic < comparison < arithmetic ---
    {
        // a | b > c + 1 should be: a | ((b > (c + 1)))
        const node = first('a | b > c + 1');
        assert(node.op === '|', 'prec chain: top is |');
        assert(node.right.op === '>', 'prec chain: right is >');
        assert(node.right.right.op === '+', 'prec chain: right.right is +');
    }

    // --- Empty input → empty program ---
    {
        const stmts = body('');
        assert(stmts.length === 0, 'empty: 0 statements');
    }

    // --- Whitespace only → empty program ---
    {
        const stmts = body('   \n\t  ');
        assert(stmts.length === 0, 'whitespace: 0 statements');
    }

    // --- Complex expression from a preset ---
    {
        const stmts = body('wave_r = wave_r + 0.400 * (0.60 * sin(0.900 * time) + 0.40 * sin(0.963 * time));');
        assert(stmts.length === 1, 'preset expr: 1 statement');
        assert(stmts[0].type === NodeType.ASSIGN, 'preset expr: assignment');
        assert(stmts[0].name === 'wave_r', 'preset expr: assigns wave_r');
    }

    // --- Modulo operator ---
    {
        const node = first('a % b');
        assert(node.type === NodeType.BINOP && node.op === '%', 'modulo: op %');
    }

    // --- Multiple unary operators ---
    {
        const node = first('--x');
        assert(node.type === NodeType.UNARYOP && node.op === '-', 'double neg: outer neg');
        assert(node.operand.type === NodeType.UNARYOP && node.operand.op === '-', 'double neg: inner neg');
    }

    // --- Assignment in expression context ---
    {
        // x = y = 5 should be x = (y = 5) (right-associative)
        const node = first('x = y = 5');
        assert(node.type === NodeType.ASSIGN, 'nested assign: outer');
        assert(node.name === 'x', 'nested assign: outer name');
        assert(node.value.type === NodeType.ASSIGN, 'nested assign: inner');
        assert(node.value.name === 'y', 'nested assign: inner name');
        assert(node.value.value.value === 5, 'nested assign: value 5');
    }

    // --- Division and subtraction precedence ---
    {
        const node = first('a - b / c');
        assert(node.op === '-', 'div prec: top is -');
        assert(node.right.op === '/', 'div prec: right is /');
    }
}
