import { expect, test } from 'bun:test';
import { isManagementOperation } from '../src/management';
test('model controls admit exact upstream operations without opening configuration or encoded paths',()=>{
  for (const [path,method] of [['/api/model-settings','PUT'],['/api/custom-models','POST'],['/api/custom-models/fixture-id','DELETE'],['/api/provider-context-caps','GET'],['/api/providers/fixture/model-costs','PUT'],['/api/providers/fixture/model-display-names','PUT']]) expect(isManagementOperation(path!,method!)).toBe(true);
  for (const [path,method] of [['/api/config','PUT'],['/api/providers/fixture/model-costs','POST'],['/api/providers/%2e%2e/model-costs','PUT'],['/api/providers/fixture/credentials','GET'],['/api/custom-models/../config','PUT'],['/api/model-settings#config','PUT']]) expect(isManagementOperation(path!,method!)).toBe(false);
});
