import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

import { noInferrableReturnType } from '../src/rules/no-inferrable-return-type';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run('no-inferrable-return-type', noInferrableReturnType, {
  invalid: [
    {
      code: 'const greet = (): string => "hi";',
      errors: [{ messageId: 'removeReturnType' }],
      output: 'const greet = () => "hi";',
    },
    {
      code: 'async function fetchAll(): Promise<void> {}',
      errors: [{ messageId: 'removeReturnType' }],
      output: 'async function fetchAll() {}',
    },
    {
      code: 'class A { m(): void {} }',
      errors: [{ messageId: 'removeReturnType' }],
      output: 'class A { m() {} }',
    },
  ],
  valid: [
    'const isString = (x: unknown): x is string => typeof x === "string";',
    'function assert(cond: unknown): asserts cond {}',
    'const greet = () => "hi";',
    'declare function exists(): number;',
    {
      code: 'const factorial = (n: number): number => n <= 1 ? 1 : n * factorial(n - 1);',
      name: 'recursive arrow — triggers TS7023 (implicit any return type)',
    },
    {
      code: [
        'type Result<T> = { error: false; value: T } | { error: true; message: string };',
        'const ok = <T>(value: T): Result<T> => ({ error: false, value });',
        'const r = ok(42);',
        'const out = r.error ? r.message : `got ${r.value}`;',
      ].join('\n'),
      name: 'generic erosion — `error: false` widens to boolean, breaking r.error narrowing at call sites',
    },
  ],
});
