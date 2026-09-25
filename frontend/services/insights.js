/* ==========================================================================
   INSIGHT ENGINE — rule-based, data-grounded observations with separate,
   optional recommendations. Every sentence is filled from computed numbers;
   a rule that has no supporting data produces nothing.
   ========================================================================== */
const Insights = (() => {
  const C = Config.INSIGHTS;
  const m = (k, v) => I18n.metric(k, v);
  const pp = v => I18n.num(v, 1);
  const dirWord = v => t(v >= 0 ? 'ins.increased' : 'ins.decreased');

  function build() {
    const out = [];
    const { cur, prev, range, cmpRange } = Reports.kpis();
    if (!cur || !cur.total || !cur.total.v.adSpend) return out;
    const V = cur.total.v, P = prev?.total?.v;
    const hasPrev = P && P.adSpend;
    const avgRoas = V.roas;

    // 1. sales vs spend growth
    if (hasPrev) {
      const s = Metrics.change('adSales', V.adSales, P.adSales), sp = Metrics.change('adSpend', V.adSpend, P.adSpend);
      if (s && sp) {
        const gap = s.pct - sp.pct;
        out.push({ kind: s.pct >= 0 ? 'growth' : 'decline', tone: gap >= 0 ? 'good' : 'bad', score: 100,
          title: t('ins.t.salesSpend'),
          obs: t('ins.salesSpend', { salesDir: dirWord(s.pct), sales: I18n.delta(s.pct), spendDir: dirWord(sp.pct), spend: I18n.delta(sp.pct) }),
          rec: Math.abs(gap) < C.minChangePct ? null : gap > 0 ? t('rec.salesOutpace') : t('rec.spendOutpace'),
          ev: [['adSales', V.adSales, P.adSales], ['adSpend', V.adSpend, P.adSpend]] });
      }
      // 2. efficiency
      if (V.roas != null && P.roas != null) {
        const ch = Metrics.change('roas', V.roas, P.roas);
        out.push({ kind: 'efficiency', tone: ch.tone, score: 95, title: t('ins.t.efficiency'),
          obs: t(Math.abs(ch.pct) < 0.5 ? 'ins.roasFlat' : 'ins.roas', { dir: dirWord(ch.pct), from: m('roas', P.roas), to: m('roas', V.roas), acosFrom: m('acos', P.acos), acosTo: m('acos', V.acos) }),
          rec: ch.tone === 'good' && Math.abs(ch.pct) >= C.minChangePct ? t('rec.efficiencyUp') : ch.tone === 'bad' && Math.abs(ch.pct) >= C.minChangePct ? t('rec.efficiencyDown') : null,
          ev: [['roas', V.roas, P.roas], ['acos', V.acos, P.acos]] });
      }
      // 3. drivers: CPC and CVR
      const cpc = Metrics.change('cpc', V.cpc, P.cpc), cvr = Metrics.change('cvr', V.cvr, P.cvr);
      if (cpc && cvr && (Math.abs(cpc.pct) >= C.minChangePct || Math.abs(cvr.pct) >= C.minChangePct)) {
        out.push({ kind: 'efficiency', tone: cpc.pct > 0 && cvr.pct < 0 ? 'bad' : cpc.pct <= 0 && cvr.pct >= 0 ? 'good' : 'neutral', score: 70,
          title: t('ins.t.drivers'),
          obs: t('ins.drivers', { cpcDir: dirWord(cpc.pct), cpc: I18n.delta(cpc.pct), cpcTo: m('cpc', V.cpc), cvrDir: dirWord(cvr.pct), cvr: I18n.delta(cvr.pct), cvrTo: m('cvr', V.cvr) }),
          rec: cpc.pct > C.minChangePct && cvr.pct < -C.minChangePct ? t('rec.cpcUpCvrDown') : null,
          ev: [['cpc', V.cpc, P.cpc], ['cvr', V.cvr, P.cvr]] });
      }
    }

    // 4. placements
    const pl = Reports.byDim('placement');
    if (pl.rows.length) {
      const top = [...pl.rows].sort((a, b) => (b.m.adSales || 0) - (a.m.adSales || 0))[0];
      if (top.share.adSales != null) out.push({ kind: 'concentration', tone: 'neutral', score: 60, title: t('ins.t.placementTop'),
        obs: t('ins.placementTop', { placement: top.id, share: pp(top.share.adSales), spendShare: pp(top.share.adSpend), roas: m('roas', top.m.roas) }),
        rec: top.m.roas > avgRoas * 1.1 ? t('rec.placementTop', { placement: top.id }) : null, ev: [['roas', top.m.roas]] });
      if (hasPrev && pl.prevTotal?.v.adSpend) {
        let best = null;
        for (const r of pl.rows) {
          if (!r.prev) continue;
          const d = r.share.adSpend - (r.prev.adSpend / pl.prevTotal.v.adSpend * 100);
          if (!best || Math.abs(d) > Math.abs(best.d)) best = { r, d, from: r.share.adSpend - d };
        }
        if (best && Math.abs(best.d) >= C.placementShiftPp) {
          const better = best.r.m.roas > avgRoas;
          out.push({ kind: 'shift', tone: (best.d > 0) === better ? 'good' : 'bad', score: 65, title: t('ins.t.placementShift'),
            obs: t('ins.placementShift', { placement: best.r.id, from: pp(best.from), to: pp(best.r.share.adSpend), roas: m('roas', best.r.m.roas), avg: m('roas', avgRoas) }),
            rec: (best.d > 0) !== better ? t('rec.placementShift', { placement: best.r.id }) : null, ev: [] });
        }
      }
    }

    // 5. portfolios
    const pf = Reports.byDim('portfolio');
    if (pf.rows.length > 1) {
      const bySales = [...pf.rows].sort((a, b) => (b.m.adSales || 0) - (a.m.adSales || 0));
      const top = bySales[0];
      out.push({ kind: 'concentration', tone: top.share.adSales >= C.concentrationPct ? 'bad' : 'neutral', score: 58, title: t('ins.t.portfolioTop'),
        obs: t('ins.portfolioTop', { portfolio: top.id, share: pp(top.share.adSales), spendShare: pp(top.share.adSpend) }),
        rec: top.share.adSales >= C.concentrationPct ? t('rec.concentration', { portfolio: top.id }) : null, ev: [] });
      const eligible = pf.rows.filter(r => r.share.adSpend >= C.minSpendSharePct && r.m.roas != null);
      const best = eligible.sort((a, b) => b.m.roas - a.m.roas)[0];
      if (best && best.m.roas > avgRoas * 1.1) out.push({ kind: 'growth', tone: 'good', score: 55, title: t('ins.t.portfolioBest'),
        obs: t('ins.portfolioBest', { portfolio: best.id, roas: m('roas', best.m.roas), avg: m('roas', avgRoas), share: pp(best.share.adSpend) }), rec: null, ev: [] });
    }

    // 6–8. campaigns
    const cp = Reports.byDim('campaign');
    if (cp.rows.length > 2) {
      const low = cp.rows.filter(r => r.m.roas != null && r.m.roas < avgRoas * C.lowRoasFactor && r.share.adSpend >= C.minSpendSharePct).sort((a, b) => b.m.adSpend - a.m.adSpend);
      if (low.length) {
        const sh = low.reduce((a, r) => a + r.share.adSpend, 0);
        out.push({ kind: 'risk', tone: 'bad', score: 90, title: t('ins.t.campaignLow'),
          obs: t('ins.campaignLow', { count: low.length, names: low.slice(0, 3).map(r => `“${r.id}”`).join(', '), share: pp(sh), roas: m('roas', low[0].m.roas), avg: m('roas', avgRoas) }),
          rec: t('rec.campaignLow'), ev: [], link: 'campaigns' });
      }
      const spends = cp.rows.map(r => r.m.adSpend || 0).sort((a, b) => a - b);
      const q3 = spends[Math.floor(spends.length * 0.75)];
      const hslr = cp.rows.filter(r => r.m.adSpend >= q3 && r.m.roas != null && r.m.roas < avgRoas && !low.includes(r)).sort((a, b) => a.m.roas - b.m.roas)[0];
      if (hslr) out.push({ kind: 'risk', tone: 'bad', score: 80, title: t('ins.t.highSpendLowReturn'),
        obs: t('ins.highSpendLowReturn', { campaign: hslr.id, share: pp(hslr.share.adSpend), roas: m('roas', hslr.m.roas), avg: m('roas', avgRoas) }),
        rec: t('rec.highSpendLowReturn'), ev: [], link: 'campaigns' });
      const opp = cp.rows.filter(r => r.m.roas != null && r.m.roas >= avgRoas * C.highRoasFactor && r.share.adSpend < C.lowSpendSharePct && (r.m.orders || 0) >= 20).sort((a, b) => b.m.roas - a.m.roas).slice(0, 2);
      if (opp.length) out.push({ kind: 'opportunity', tone: 'good', score: 85, title: t('ins.t.opportunity'),
        obs: t('ins.opportunity', { names: opp.map(r => `“${r.id}”`).join(', '), roas: m('roas', opp[0].m.roas), share: pp(opp[0].share.adSpend), avg: m('roas', avgRoas) }),
        rec: t('rec.opportunity'), ev: [], link: 'campaigns' });
      // campaign with the steepest ROAS decline vs comparison
      if (hasPrev) {
        const dec = cp.rows.filter(r => r.prev && r.share.adSpend >= C.minSpendSharePct).map(r => ({ r, ch: Metrics.change('roas', r.m.roas, r.prev.roas) })).filter(x => x.ch && x.ch.pct <= -10).sort((a, b) => a.ch.pct - b.ch.pct)[0];
        if (dec) out.push({ kind: 'decline', tone: 'bad', score: 75, title: t('ins.t.campaignDecline'),
          obs: t('ins.campaignDecline', { campaign: dec.r.id, from: m('roas', dec.r.prev.roas), to: m('roas', dec.r.m.roas), cvrFrom: m('cvr', dec.r.prev.cvr), cvrTo: m('cvr', dec.r.m.cvr) }),
          rec: t('rec.campaignDecline'), ev: [], link: 'campaigns' });
      }
    }

    // 9. keywords
    const kw = Reports.byDim('keyword+matchType+campaign');
    if (kw.rows.length > 3) {
      const avgCvr = kw.total.v.cvr;
      const opp = kw.rows.filter(r => r.m.roas >= avgRoas * C.highRoasFactor && r.m.cvr >= avgCvr && r.share.adSpend < C.lowSpendSharePct && (r.m.orders || 0) >= 10).sort((a, b) => b.m.roas - a.m.roas).slice(0, 3);
      if (opp.length) out.push({ kind: 'opportunity', tone: 'good', score: 72, title: t('ins.t.keywordOpp'),
        obs: t('ins.keywordOpp', { names: opp.map(r => `“${r.id}”`).join(', '), roas: m('roas', opp[0].m.roas), cvr: m('cvr', opp[0].m.cvr), avgCvr: m('cvr', avgCvr) }),
        rec: t('rec.keywordOpp'), ev: [], link: 'keywords' });
    }

    // 10. search terms
    const st = Reports.byDim('searchTerm');
    if (st.rows.length) {
      const wasted = st.rows.filter(r => (r.m.clicks || 0) >= C.wastedSpendMinClicks && !r.m.orders);
      if (wasted.length) {
        const sp = wasted.reduce((a, r) => a + (r.m.adSpend || 0), 0);
        out.push({ kind: 'risk', tone: 'bad', score: 78, title: t('ins.t.wasted'),
          obs: t('ins.wasted', { count: wasted.length, spend: I18n.money(sp), clicks: C.wastedSpendMinClicks }), rec: t('rec.negatives'), ev: [], link: 'search-terms' });
      }
      const low = st.rows.filter(r => r.m.roas != null && r.m.roas < avgRoas * C.lowRoasFactor && r.share.adSpend >= 1).sort((a, b) => b.m.adSpend - a.m.adSpend).slice(0, 3);
      if (low.length) out.push({ kind: 'risk', tone: 'bad', score: 68, title: t('ins.t.termLow'),
        obs: t('ins.termLow', { names: low.map(r => `“${r.id}”`).join(', '), roas: m('roas', low[0].m.roas), avg: m('roas', avgRoas) }), rec: t('rec.termLow'), ev: [], link: 'search-terms' });
    }

    // 11. ASINs
    const as = Reports.byDim('asin+title+asinStatus');
    if (as.rows.length) {
      const bad = as.rows.filter(r => r.asinStatus && r.asinStatus !== 'Active' && (r.m.adSpend || 0) > 0).sort((a, b) => b.m.adSpend - a.m.adSpend);
      if (bad.length) out.push({ kind: 'risk', tone: 'bad', score: 88, title: t('ins.t.asinStatus'),
        obs: t('ins.asinStatus', { count: bad.length, asin: bad[0].id, status: t('status.' + bad[0].asinStatus) || bad[0].asinStatus, spend: I18n.money(bad[0].m.adSpend), roas: m('roas', bad[0].m.roas) }),
        rec: t('rec.asinStatus'), ev: [], link: 'asins' });
      if (hasPrev) {
        const withCh = as.rows.filter(r => r.prev && r.share.adSales >= C.minSpendSharePct).map(r => ({ r, ch: Metrics.change('adSales', r.m.adSales, r.prev.adSales) })).filter(x => x.ch);
        const up = withCh.filter(x => x.ch.pct >= 10).sort((a, b) => b.ch.pct - a.ch.pct)[0];
        const down = withCh.filter(x => x.ch.pct <= -10).sort((a, b) => a.ch.pct - b.ch.pct)[0];
        if (up) out.push({ kind: 'growth', tone: 'good', score: 50, title: t('ins.t.asinGrowth'),
          obs: t('ins.asinGrowth', { asin: up.r.id, title: up.r.title || '', pct: I18n.delta(up.ch.pct), sales: I18n.money(up.r.m.adSales) }), rec: null, ev: [], link: 'asins' });
        if (down) out.push({ kind: 'decline', tone: 'bad', score: 62, title: t('ins.t.asinDecline'),
          obs: t('ins.asinDecline', { asin: down.r.id, title: down.r.title || '', pct: I18n.delta(down.ch.pct), sales: I18n.money(down.r.m.adSales) }), rec: t('rec.asinDecline'), ev: [], link: 'asins' });
      }
    }

    // 12. new-to-brand (only where reported)
    if (V.ntbOrderRate != null) out.push({ kind: 'growth', tone: 'neutral', score: 40, title: t('ins.t.ntb'),
      obs: t('ins.ntb', { rate: m('ntbOrderRate', V.ntbOrderRate), sales: I18n.money(V.ntbSales), cov: pp(cur.total.cov.ntbOrders * 100) }), rec: null, ev: [] });

    return out.sort((a, b) => b.score - a.score);
  }

  /* compact fact sheet for the optional Claude summary — numbers only from the engine */
  function factSheet(list) {
    const { cur, prev, range, cmpRange } = Reports.kpis();
    const V = cur.total.v, P = prev?.total?.v;
    const k = ['adSpend', 'adSales', 'roas', 'acos', 'orders', 'cvr', 'cpc', 'ctr'];
    return {
      period: I18n.range(range[0], range[1]), comparison: cmpRange ? I18n.range(cmpRange[0], cmpRange[1]) : null,
      marketplace: State.get().marketplace, currency: I18n.currency(),
      kpis: Object.fromEntries(k.map(x => [x, { current: I18n.metric(x, V[x]), previous: P ? I18n.metric(x, P[x]) : null }])),
      observations: list.map(i => i.obs), recommendations: list.filter(i => i.rec).map(i => i.rec),
    };
  }
  return { build, factSheet };
})();
