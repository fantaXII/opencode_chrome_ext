// native host가 마지막으로 바뀐 릴리스 버전. 설치된 host가 이보다 낮을 때만 업데이트를 안내한다.
// (확장 버전과 비교하면 host가 그대로인 릴리스에서도 매번 재설치를 안내하게 된다.)
// 릴리스 때 scripts/sync-host-version.js(release-it after:bump)가 직전 태그 이후
// native-host/ 또는 installer/가 바뀌었으면 새 버전으로 고친다. 손으로 고치지 않는다.
export const MIN_HOST_VERSION = '2.21.0';
