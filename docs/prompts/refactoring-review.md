# open-plant 리팩토링 검토

## 1. 거대 파일 분해

| 파일 | 줄 수 | 핵심 문제 |
|------|------:|-----------|
| `wsi-tile-renderer.ts` | **1536** | 11가지 관심사 혼합: 셰이더, 인터랙션, 타일 캐시, 뷰 애니메이션, 포인트 버퍼, 정규화 헬퍼 등 |
| `wsi-viewer-canvas.tsx` | **1226** | 7가지 독립 서브시스템이 하나의 컴포넌트: 포인트 히트테스트, ROI 클립, 리전 인터랙션, 라벨 애니메이션, 커스텀 레이어, 오버뷰맵 등. props 60개 이상 |
| `draw-layer.tsx` | **959** | `drawOverlay` 콜백 207줄. 포인터 이벤트 상태 머신이 컴포넌트에 직접 포함 |
| `overview-map.tsx` | **713** | 썸네일 fetch, 뷰포트 렌더링, 포인터 인터랙션이 하나의 컴포넌트 |
| `brush-stroke.ts` | **596** | 단일 모듈이나 내부 함수는 적절히 분리됨. 중복만 해결하면 됨 |

---

## 2. 코드 중복 (11건)

| 중복 | 위치 (파일 수) | 대응 |
|------|:-----------:|------|
| `nowMs()` | 5곳 | `wsi/utils.ts`로 통합 |
| `sanitizePointCount()` | 4곳 (inline 포함) | `wsi/utils.ts`로 통합 |
| `closeRing()` / `closeRoiRing()` | 3곳 (`brush-stroke`, `roi-geometry`, `draw-layer-utils`) | `roi-geometry`를 canonical로, 나머지는 import |
| `polygonSignedArea()` | 2곳 (`brush-stroke`, `roi-geometry`) | `roi-geometry`를 canonical로 |
| `createProgram()` (WebGL) | 2곳 (`core/gl-utils`, `wsi/utils`) | `core/gl-utils`를 canonical로, `wsi/utils`에서 제거 |
| `requireUniformLocation()` | 2곳 (`core/gl-utils`, `wsi-tile-renderer`) | `core/gl-utils`에서 import |
| `isSameViewState()` | 2곳 (`wsi/utils`, `wsi-tile-renderer` 내부) | `wsi/utils`를 canonical로 |
| `cellHash()` | 2곳 (worker client + worker) | 공유 모듈로 추출 |
| `toDrawCoordinate()` / `toCoord()` | 3곳 (`draw-layer-utils`, `wsi-viewer-canvas`, `wsi-region-hit-utils`) | `draw-layer-utils`를 canonical로 |
| Worker 라이프사이클 패턴 | 2곳 (`point-clip-worker-client`, `point-hit-index-worker-client`) | 제네릭 `WorkerClient<TReq, TRes>` 추상화 |
| 공간 인덱스 빌드 로직 | 2곳 (worker client의 sync fallback + worker 본체) | 공유 빌드 함수 추출 |

---

## 3. `wsi-tile-renderer.ts` 분해 제안

| 신규 모듈 | 내용 | 예상 줄 수 |
|-----------|------|:----------:|
| `wsi-renderer-types.ts` | `CachedTile`, `TileVertexProgram`, `PointProgram`, `PointSizeStop`, `ViewAnimationState`, `NormalizedImageColorSettings`, `WorldPoint`, `Bounds` + 옵션 인터페이스 | ~115 |
| `wsi-normalize.ts` | 정규화/헬퍼 함수 16개 (`normalizePointSizeStops`, `normalizeStrokeScale`, `toNormalizedImageColorSettings` 등) | ~140 |
| `wsi-shaders.ts` | GLSL 소스 + `initTileProgram()`, `initPointProgram()` | ~230 |
| `wsi-interaction.ts` | `onPointerDown/Move/Up`, `onWheel`, `onDoubleClick`, `onContextMenu`, `cancelDrag`, 드래그 상태 | ~100 |
| `wsi-tile-cache.ts` | `cache` Map, `trimCache`, `handleTileLoaded`, `createTextureFromBitmap` | ~65 |
| `wsi-view-animation.ts` | `ViewAnimationState`, `cancelViewAnimation`, `startViewAnimation`, RAF 루프 | ~60 |
| `wsi-tile-renderer.ts` | 오케스트레이터 클래스 | ~500 |

---

## 4. `wsi-viewer-canvas.tsx` 훅 추출 제안

| 추출 대상 | 형태 | 현재 위치 |
|-----------|------|----------|
| 포인트 히트테스트 + 공간 인덱싱 | `usePointHitTest` 훅 | lines 500-612 |
| ROI 포인트 클립 (sync/worker/hybrid) | `usePointClip` 훅 | lines 402-498 |
| 리전 hover/click/active 인터랙션 | `useRegionInteraction` 훅 | lines 799-987 |
| 라벨 auto-lift 애니메이션 | `useAutoLiftAnimation` 훅 | lines 335-400 |

props 60개 이상 → 관련 props를 옵션 객체로 그룹화 (예: `regionInteractionConfig`, `pointClipConfig`)

---

## 5. `draw-layer.tsx` 추가 정리

- `drawOverlay` 207줄 → 렌더 패스별 함수 분리 (`renderPersistedRegions`, `renderPatchRegions`, `renderPreview`, `renderLabels`, `renderAreaTooltip`)
- 포인터 상태 머신 (`handlePointerDown/Move/Up`, `finishSession`, `appendBrushPoint`) → `useDrawInteraction` 훅으로 추출
- `import("./draw-layer-types").DrawCoordinate` 인라인 타입 참조 ~15곳 → 이미 import된 타입 직접 사용

---

## 6. `wsi/utils.ts` 관심사 분리

현재 무관한 유틸이 혼재:

| 그룹 | 함수 |
|------|------|
| 수학/일반 | `clamp`, `nowMs` (신규 통합), `sanitizePointCount` (신규 통합) |
| 스케일 계산 | `calcScaleResolution`, `calcScaleLength` |
| 뷰 상태 | `isSameViewState` |
| 인증 | `toBearerToken` |
| 색상 | `hexToRgba`, `buildTermPalette` |
| **WebGL** | `createProgram` → `core/gl-utils`로 이동해야 함 |

---

## 7. 우선순위

| 우선순위 | 작업 | 효과 |
|:--------:|------|------|
| **P0** | 코드 중복 11건 통합 | 유지보수성, 버그 감소 |
| **P0** | `draw-layer.tsx` 인라인 타입 참조 정리 | 가독성 |
| **P1** | `wsi-tile-renderer.ts` 모듈 분해 | 테스트 가능성, 이해도 |
| **P1** | `wsi-viewer-canvas.tsx` 훅 추출 | 재사용성, 테스트 가능성 |
| **P2** | `draw-layer.tsx` drawOverlay 분리 + 훅 추출 | 가독성, 유지보수성 |
| **P2** | `overview-map.tsx` 분리 (썸네일/뷰포트/인터랙션) | 가독성 |
| **P3** | `wsi/utils.ts` 관심사 분리 | API 명확성 |
| **P3** | Worker 클라이언트 제네릭 추상화 | 중복 제거 |
