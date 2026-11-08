import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { mapMntToWslPath } = createRequire(import.meta.url)('../native-host/host.js');

test('WSL을 가리키는 네트워크 드라이브의 /mnt/<x>를 리눅스 경로로 복구', () => {
  assert.equal(mapMntToWslPath('/mnt/z/home/fanta/x', '\\\\wsl.localhost\\Ubuntu\\'), '/home/fanta/x');
  assert.equal(mapMntToWslPath('/mnt/z', '\\\\wsl$\\Ubuntu'), '/');
  assert.equal(mapMntToWslPath('/mnt/z/a', '\\\\wsl$\\Ubuntu\\home\\fanta'), '/home/fanta/a');
});

test('WSL을 가리키지 않거나 /mnt가 아니면 null', () => {
  assert.equal(mapMntToWslPath('/mnt/c/x', '\\\\server\\share'), null);
  assert.equal(mapMntToWslPath('/home/x', '\\\\wsl$\\Ubuntu'), null);
  assert.equal(mapMntToWslPath('/mnt/z/x', null), null);
});
