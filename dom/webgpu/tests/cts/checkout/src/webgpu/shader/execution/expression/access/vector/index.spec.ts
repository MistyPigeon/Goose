export const description = `
Execution Tests for vector indexing expressions
`;

import { makeTestGroup } from '../../../../../../common/framework/test_group.js';
import { AllFeaturesMaxLimitsGPUTest } from '../../../../../gpu_test.js';
import { ScalarValue, Type, VectorValue, f32 } from '../../../../../util/conversion.js';
import { Case } from '../../case.js';
import { allInputSources, basicExpressionBuilder, run } from '../../expression.js';

export const g = makeTestGroup(AllFeaturesMaxLimitsGPUTest);

g.test('concrete_scalar')
  .specURL('https://www.w3.org/TR/WGSL/#vector-access-expr')
  .desc(`Test indexing of concrete vectors`)
  .params(u =>
    u
      .combine('inputSource', allInputSources)
      .combine('elementType', ['i32', 'u32', 'f32', 'f16', 'bool'] as const)
      .combine('indexType', ['i32', 'u32'] as const)
      .combine('width', [2, 3, 4] as const)
  )
  .fn(async t => {
    if (t.params.elementType === 'f16') {
      t.skipIfDeviceDoesNotHaveFeature('shader-f16');
    }
    const elementType = Type[t.params.elementType];
    const indexType = Type[t.params.indexType];
    const vectorType = Type.vec(t.params.width, elementType);
    const elements: ScalarValue[] = [];
    for (let i = 0; i < t.params.width; i++) {
      if (t.params.elementType === 'bool') {
        elements.push(elementType.create(i & 1));
      } else {
        elements.push(elementType.create((i + 1) * 10));
      }
    }
    const vector = new VectorValue(elements);
    const cases: Case[] = [];
    for (let i = 0; i < t.params.width; i++) {
      cases.push({ input: [vector, indexType.create(i)], expected: elements[i] });
    }

    await run(
      t,
      basicExpressionBuilder(ops => `${ops[0]}[${ops[1]}]`),
      [vectorType, indexType],
      elementType,
      t.params,
      cases
    );
  });

g.test('abstract_scalar')
  .specURL('https://www.w3.org/TR/WGSL/#vector-access-expr')
  .desc(`Test indexing of abstract numeric vectors`)
  .params(u =>
    u
      .combine('elementType', ['abstract-int', 'abstract-float'] as const)
      .combine('indexType', ['i32', 'u32'] as const)
      .combine('width', [2, 3, 4] as const)
  )
  .fn(async t => {
    const elementType = Type[t.params.elementType];
    const indexType = Type[t.params.indexType];
    const vectorType = Type.vec(t.params.width, elementType);
    const elements: ScalarValue[] = [];
    for (let i = 0; i < t.params.width; i++) {
      elements.push(elementType.create((i + 1) * 0x100000000));
    }
    const vector = new VectorValue(elements);
    const cases: Case[] = [];
    for (let i = 0; i < t.params.width; i++) {
      cases.push({ input: [vector, indexType.create(i)], expected: f32(i + 1) });
    }

    await run(
      t,
      basicExpressionBuilder(ops => `${ops[0]}[${ops[1]}] / 0x100000000`),
      [vectorType, indexType],
      Type.f32,
      { inputSource: 'const' },
      cases
    );
  });
