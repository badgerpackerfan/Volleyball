/** Diagram checks use disc centers, not player feet at service contact. */
export function receiveLayoutError(points) {
  for (let p=1;p<=6;p++) {
    const at=points?.[p];
    if(!at || !Number.isFinite(at.left) || !Number.isFinite(at.top)) return 'Formation must contain six valid positions.';
    if(at.left<6.666 || at.left>93.334 || at.top<6.666 || at.top>93.334) return 'Keep all players inside the court.';
  }
  for(const [a,b] of [[4,3],[3,2],[5,6],[6,1]])
    if(points[b].left-points[a].left<4.95) return `P${a} must stay left of P${b}.`;
  for(const [front,back] of [[4,5],[3,6],[2,1]])
    if(points[back].top-points[front].top<4.95) return `P${back} must stay behind P${front}.`;
  for(let a=1;a<=6;a++) for(let b=a+1;b<=6;b++)
    if(Math.hypot(points[b].left-points[a].left,points[b].top-points[a].top)<13)
      return `Leave space between P${a} and P${b}.`;
  return null;
}
