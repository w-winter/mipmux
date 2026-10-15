import type { ElicitRequestFormParams } from '@modelcontextprotocol/server';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { ClientQuestionResponse, PendingQuestion } from '../contracts/interaction.js';
import { WorkspaceFailure } from '../workspace/values.js';

const textAnswer = Compile(Type.Union([Type.String(), Type.Undefined()]));
const multipleAnswer = Compile(Type.Union([Type.Array(Type.String()), Type.Undefined()]));

/** MCP forms use indexed keys; native conversion retains the original question IDs and answer envelope. */
export function questionForm(question: PendingQuestion): ElicitRequestFormParams {
  const properties: ElicitRequestFormParams['requestedSchema']['properties'] = {};
  question.fields.forEach((field, index) => {
    const key = 'question_' + index, property = field.property;
    if (property.type === 'string') properties[key] = property;
    else if (property.items.enum) properties[key] = { type: 'array', title: property.title,
      description: property.description, items: { type: 'string', enum: property.items.enum } };
    else {
      if (field.optionLabels.length) properties[key + '_options'] = { type: 'array', title: property.title,
        description: property.description, items: { type: 'string', enum: field.optionLabels } };
      properties[key + '_custom'] = { type: 'string', title: property.title + ' (custom answer)', description: property.description };
    }
  });
  return { mode: 'form', message: question.message, requestedSchema: { ...question.requestedSchema, properties } };
}

export function sourceQuestionResponse(question: PendingQuestion, response: ClientQuestionResponse): ClientQuestionResponse {
  if (response.action !== 'accept') return response;
  const content = response.content ?? {};
  const source = Object.fromEntries(question.fields.flatMap((field, index): [string, string | string[]][] => {
    const key = 'question_' + index, property = field.property;
    if (property.type === 'string') {
      const value = content[key];
      if (!textAnswer.Check(value)) throw new WorkspaceFailure('invalidInteractionResponse');
      return value === undefined ? [] : [[field.id, value]];
    }
    if (property.items.enum) {
      const value = content[key];
      if (!multipleAnswer.Check(value)) throw new WorkspaceFailure('invalidInteractionResponse');
      return value === undefined ? [] : [[field.id, value]];
    }
    const selected = content[key + '_options'], custom = content[key + '_custom'];
    if (!multipleAnswer.Check(selected) || !textAnswer.Check(custom)) throw new WorkspaceFailure('invalidInteractionResponse');
    const values = [...selected ?? []];
    if (custom !== undefined) values.push(custom);
    return [[field.id, values]];
  }));
  if (!Compile(question.requestedSchema).Check(source)) throw new WorkspaceFailure('invalidInteractionResponse');
  return { action: 'accept', content: source };
}
