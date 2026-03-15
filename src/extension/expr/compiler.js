/**
 * MilkDrop 2 expression compiler.
 * Compiles expression source to a closure: (ctx) => void.
 * No eval(), no Function() — builds closure tree from AST walk.
 * Pure JS — no GI imports.
 */

import { parse, NodeType } from './parser.js';
import { builtins, EPSILON } from './functions.js';

/**
 * Compile a MilkDrop expression string into an executable function.
 * @param {string} src - Expression source code
 * @returns {function(Object): void} - Function that mutates the context object
 */
export function compile(src) {
    const ast = parse(src);
    const stmts = ast.body.map(node => compileNode(node));

    return function execute(ctx) {
        // Ensure megabuf/gmegabuf arrays exist on context
        if (!ctx._megabuf) ctx._megabuf = new Float64Array(1048576);
        if (!ctx._gmegabuf) ctx._gmegabuf = new Float64Array(1048576);

        for (let i = 0; i < stmts.length; i++) {
            stmts[i](ctx);
        }
    };
}

function safeNum(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

function compileNode(node) {
    switch (node.type) {
        case NodeType.LITERAL: {
            const val = node.value;
            return (_ctx) => val;
        }
        case NodeType.IDENT: {
            const name = node.name;
            return (ctx) => ctx[name] !== undefined ? ctx[name] : 0;
        }
        case NodeType.ASSIGN: {
            const name = node.name;
            const valFn = compileNode(node.value);
            return (ctx) => { const v = safeNum(valFn(ctx)); ctx[name] = v; return v; };
        }
        case NodeType.MEMASSIGN: {
            const bufKey = node.buf === 'megabuf' ? '_megabuf' : '_gmegabuf';
            const idxFn = compileNode(node.index);
            const valFn = compileNode(node.value);
            return (ctx) => {
                const idx = Math.floor(idxFn(ctx));
                const v = safeNum(valFn(ctx));
                if (idx >= 0 && idx < 1048576) ctx[bufKey][idx] = v;
                return v;
            };
        }
        case NodeType.BINOP:
            return compileBinOp(node);
        case NodeType.UNARYOP:
            return compileUnaryOp(node);
        case NodeType.CALL:
            return compileCall(node);
        default:
            return (_ctx) => 0;
    }
}

function compileBinOp(node) {
    const leftFn = compileNode(node.left);
    const rightFn = compileNode(node.right);

    switch (node.op) {
        case '+': return (ctx) => leftFn(ctx) + rightFn(ctx);
        case '-': return (ctx) => leftFn(ctx) - rightFn(ctx);
        case '*': return (ctx) => leftFn(ctx) * rightFn(ctx);
        case '/': return (ctx) => { const r = rightFn(ctx); return r !== 0 ? leftFn(ctx) / r : 0; };
        case '%': return (ctx) => { const r = rightFn(ctx); return r !== 0 ? leftFn(ctx) % r : 0; };
        case '^': return (ctx) => safeNum(Math.pow(leftFn(ctx), rightFn(ctx)));
        // Comparisons
        case '==': return (ctx) => Math.abs(leftFn(ctx) - rightFn(ctx)) < EPSILON ? 1 : 0;
        case '!=': return (ctx) => Math.abs(leftFn(ctx) - rightFn(ctx)) >= EPSILON ? 1 : 0;
        case '<':  return (ctx) => leftFn(ctx) < rightFn(ctx) ? 1 : 0;
        case '>':  return (ctx) => leftFn(ctx) > rightFn(ctx) ? 1 : 0;
        case '<=': return (ctx) => leftFn(ctx) <= rightFn(ctx) ? 1 : 0;
        case '>=': return (ctx) => leftFn(ctx) >= rightFn(ctx) ? 1 : 0;
        // Logic
        case '&': return (ctx) => (Math.abs(leftFn(ctx)) > EPSILON && Math.abs(rightFn(ctx)) > EPSILON) ? 1 : 0;
        case '|': return (ctx) => (Math.abs(leftFn(ctx)) > EPSILON || Math.abs(rightFn(ctx)) > EPSILON) ? 1 : 0;
        default: return (_ctx) => 0;
    }
}

function compileUnaryOp(node) {
    const operandFn = compileNode(node.operand);
    switch (node.op) {
        case '-': return (ctx) => -operandFn(ctx);
        case '!': return (ctx) => Math.abs(operandFn(ctx)) < EPSILON ? 1 : 0;
        default: return operandFn;
    }
}

function compileCall(node) {
    const name = node.name;
    const argFns = node.args.map(compileNode);

    // Special: megabuf / gmegabuf — can appear as lvalue in assignment-like form
    // megabuf(i) reads, megabuf(i) = v is handled by parser as assign to call
    // but we also need megabuf(i) as a read
    if (name === 'megabuf') {
        return (ctx) => {
            const idx = Math.floor(argFns[0](ctx));
            if (idx >= 0 && idx < 1048576) return ctx._megabuf[idx];
            return 0;
        };
    }
    if (name === 'gmegabuf') {
        return (ctx) => {
            const idx = Math.floor(argFns[0](ctx));
            if (idx >= 0 && idx < 1048576) return ctx._gmegabuf[idx];
            return 0;
        };
    }

    const fn = builtins[name];
    if (!fn) return (_ctx) => 0;

    // Optimize common arities
    if (argFns.length === 1) {
        const a0 = argFns[0];
        return (ctx) => safeNum(fn(a0(ctx)));
    }
    if (argFns.length === 2) {
        const a0 = argFns[0], a1 = argFns[1];
        return (ctx) => safeNum(fn(a0(ctx), a1(ctx)));
    }
    if (argFns.length === 3) {
        const a0 = argFns[0], a1 = argFns[1], a2 = argFns[2];
        return (ctx) => safeNum(fn(a0(ctx), a1(ctx), a2(ctx)));
    }

    return (ctx) => safeNum(fn(...argFns.map(f => f(ctx))));
}
