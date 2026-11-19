/**
 * Agrupamiento temático no supervisado mediante Spherical K-Means++ (distancia coseno)
 * y cálculo de Silhouette Score.
 */
(function (root) {
  const BiblioWorker = (root.BiblioWorker = root.BiblioWorker || {});

  class KMeansClusterer {
    cluster(vectorsMap, stemToSurface = {}, kOpt = null) {
      const { TfIdf, Utf8Helper } = BiblioWorker;
      const keys = Object.keys(vectorsMap).sort((a, b) => Number(a) - Number(b));
      const n = keys.length;
      if (n === 0) {
        return { k: 0, clusters: [], assignments: {}, silhouette: 0.0, iterations: 0 };
      }

      let k = kOpt !== null ? kOpt : Math.max(2, Math.min(5, Math.round(Math.sqrt(n / 1.5))));
      k = Math.min(k, n);

      const centroids = [vectorsMap[keys[0]]];
      const chosen = new Set([keys[0]]);

      for (let c = 1; c < k; c++) {
        let bestKey = null;
        let bestDist = -1.0;
        for (const key of keys) {
          if (chosen.has(key)) continue;
          let minDist = Infinity;
          for (const cent of centroids) {
            const d = 1.0 - TfIdf.cosine(vectorsMap[key], cent);
            if (d < minDist) minDist = d;
          }
          if (minDist > bestDist) {
            bestDist = minDist;
            bestKey = key;
          }
        }
        if (bestKey === null) break;
        chosen.add(bestKey);
        centroids.push(vectorsMap[bestKey]);
      }

      k = centroids.length;
      const assignments = {};
      let iterations = 0;

      for (let iter = 1; iter <= 30; iter++) {
        iterations = iter;
        let changed = false;
        const groups = Array.from({ length: k }, () => []);

        for (const key of keys) {
          let bestC = 0;
          let bestSim = -Infinity;
          for (let c = 0; c < k; c++) {
            const sim = TfIdf.cosine(vectorsMap[key], centroids[c]);
            if (sim > bestSim) {
              bestSim = sim;
              bestC = c;
            }
          }
          if (assignments[key] !== bestC) changed = true;
          assignments[key] = bestC;
          groups[bestC].push(key);
        }

        for (let c = 0; c < k; c++) {
          if (groups[c].length > 0) {
            centroids[c] = TfIdf.centroid(groups[c].map((gk) => vectorsMap[gk]));
          }
        }
        if (!changed) break;
      }

      const silhouette = this._computeSilhouette(vectorsMap, keys, assignments);
      const clusters = [];

      for (let c = 0; c < k; c++) {
        const members = keys.filter((key) => assignments[key] === c);
        if (members.length === 0) continue;

        const topTerms = Object.entries(centroids[c])
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([stem]) => Utf8Helper.ucfirst(stemToSurface[stem] || stem));

        const label = topTerms.slice(0, 3).join(' · ') || `Clúster ${c + 1}`;
        clusters.push({
          cluster_id: c,
          label,
          top_terms: topTerms,
          members: members.map((m) => Number(m))
        });
      }

      return {
        k: clusters.length,
        clusters,
        assignments,
        silhouette: Number(silhouette.toFixed(4)),
        iterations
      };
    }

    _computeSilhouette(vectorsMap, keys, assignments) {
      const { TfIdf } = BiblioWorker;
      const n = keys.length;
      if (n <= 2) return 0.0;

      const byCluster = new Map();
      for (const k of keys) {
        const c = assignments[k];
        if (!byCluster.has(c)) byCluster.set(c, []);
        byCluster.get(c).push(k);
      }
      if (byCluster.size < 2) return 0.0;

      let sumS = 0.0;
      for (const i of keys) {
        const ci = assignments[i];
        const same = byCluster.get(ci);
        if (same.length <= 1) continue;

        let a = 0.0;
        for (const j of same) {
          if (j !== i) a += 1.0 - TfIdf.cosine(vectorsMap[i], vectorsMap[j]);
        }
        a /= same.length - 1;

        let b = Infinity;
        for (const [otherC, otherMembers] of byCluster.entries()) {
          if (otherC === ci || otherMembers.length === 0) continue;
          let dSum = 0.0;
          for (const j of otherMembers) {
            dSum += 1.0 - TfIdf.cosine(vectorsMap[i], vectorsMap[j]);
          }
          const avgD = dSum / otherMembers.length;
          if (avgD < b) b = avgD;
        }

        const denom = Math.max(a, b);
        if (denom > 0.0 && b < Infinity) {
          sumS += (b - a) / denom;
        }
      }
      return sumS / n;
    }
  }

  BiblioWorker.KMeansClusterer = KMeansClusterer;
})(self);
