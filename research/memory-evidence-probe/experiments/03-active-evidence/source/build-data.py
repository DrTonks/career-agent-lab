#!/usr/bin/env python3
"""Build V11 fictional continuous trajectories and a private reference oracle.

Public files contain source observations, never derived target answers. The
private reducer independently applies events and readable confirmations in order.
No network calls, random sampling, model outputs, or result-based selection.
This reuses the four V10 sequence templates with new jobs, IDs, and parameters;
it is new within-template data, not an independent generalization benchmark.
"""

import hashlib
import itertools
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FIELDS = ("days", "hours", "applied")
JOBS = (
    ("木版年画编目助理", 3, 32),
    ("盐沼影像巡检助理", 2, 25),
    ("钟表藏品测绘助理", 4, 34),
)


def ident(kind, *parts):
    digest = hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:12]
    return f"{kind}-{digest}"


def known(value):
    return {"value": value, "alternatives": None}


def choices(*values):
    return {"value": None, "alternatives": list(values)}


def open_value():
    return {"value": None, "alternatives": None}


def describe(observations):
    names = {"days": "每周排班天数", "hours": "每天排班小时数", "applied": "申请是否仍在途"}
    parts = []
    for field, entry in observations.items():
        value, alternatives = entry["value"], entry["alternatives"]
        if value is not None:
            if field == "applied":
                parts.append("本人申请已提交且仍在途。" if value else "本人目前没有在途申请。")
            else:
                unit = "天" if field == "days" else "小时"
                parts.append(f"本人{names[field]}为{value}{unit}。")
        elif alternatives is not None:
            parts.append(f"本人{names[field]}尚未确定，全部且仅有的候选为"
                         + "、".join(str(v) for v in alternatives) + "；候选穷尽所有可能。")
        else:
            parts.append(f"本人{names[field]}尚未确定，目前没有具体值，也未提供穷尽候选；旧值不能继续作为本轮事实。")
    if sum(e["alternatives"] is not None for e in observations.values()) > 1:
        parts.append("以上不同字段的候选可独立组合，不存在未说明的组合限制。")
    return "".join(parts)


def rule_record(tid, scope, job, version, minimum, threshold):
    return {
        "id": ident("d", tid, scope, "rule", version),
        "text": f"来源系统规则原件，第{version}版，作用域{scope}，岗位“{job}”。"
                f"完整资格条件为每周至少{minimum}天，且每周总排班时长至少{threshold}小时；"
                "总排班时长=每周天数×每天小时数，两项须同时满足，无认证替代或其他隐含条件。"
                "本版从载有它的本轮事件开始生效，并替代同作用域此前规则。"
                "天数为非负整数，每天小时数为非负数。"
                "行动约定：符合且没有在途申请为apply，符合且申请在途为wait；"
                "不符合且申请在途为withdraw，不符合且没有在途申请为none。"
                "报告recommend与资格一致。原文穷尽的全部可能情形结论相同则可确定目标，"
                "否则目标值为null且status=uncertain；确定目标status=current。"
                "这里只维护建议，不执行外部操作；已撤回申请不得再次建议撤回。",
        "minDays": minimum,
        "minHours": threshold,
    }


def to_domain(entry):
    if entry["value"] is not None:
        return [entry["value"]]
    alternatives = entry["alternatives"]
    return None if alternatives is None else list(alternatives)


def apply_observations(domains, observations):
    for field, entry in observations.items():
        domains[field] = to_domain(entry)


def copy_domains(domains):
    return {key: None if value is None else list(value) for key, value in domains.items()}


class Builder:
    """Construct evidence only; never insert a derived answer into public data."""

    def __init__(self, job_index, variant):
        job, minimum, threshold = JOBS[job_index]
        self.tid = ident("t", "v11", job_index, variant)
        self.scope = ident("scope", self.tid, "person-job")
        self.other_scope = ident("scope", self.tid, "other-person-job")
        self.job, self.variant = job, variant
        self.tighten_margin = (2, 4, 5)[job_index]
        self.relax_margin = (2, 3, 4)[job_index]
        self.rule_version = 1
        self.rule = rule_record(self.tid, self.scope, job, 1, minimum, threshold)
        days = minimum + 1 + variant % 2
        hours = (threshold + days - 1) // days + 1
        self.initial = {"days": days, "hours": hours, "applied": variant != 3}
        self.domains = {k: [v] for k, v in self.initial.items()}
        self.events, self.categories = [], []

    def document(self, index, title, scope, observations, prefix=""):
        step = len(self.events) + 1
        return {"id": ident("d", self.tid, step, index), "title": title,
                "text": f"来源系统登记，记录版本{step}，第{step}轮第{index}号，作用域{scope}。"
                        + prefix + describe(observations),
                "scope": scope, "observations": observations}

    def unrelated_document(self, index=2):
        return self.document(index, "排班登记回执", self.other_scope,
                             {"days": known(2), "hours": known(3), "applied": known(False)},
                             "这是另一人的另一岗位记录，仅对标明作用域有效。")

    def add(self, category, observations, prefix, documents=None, new_rule=None, scope=None):
        step = len(self.events) + 1
        source_scope = scope or self.scope
        event = {
            "id": ident("e", self.tid, step), "scope": source_scope,
            "text": f"来源系统第{step}轮观测，观测版本{step}，作用域{source_scope}。" + prefix + describe(observations),
            "observations": observations,
            "documents": documents if documents is not None else [self.unrelated_document()],
        }
        if new_rule is not None:
            event["rule"] = new_rule
        # Stable ID ordering avoids a privileged confirmation position.
        event["documents"].sort(key=lambda d: d["id"])
        self.events.append(event)
        self.categories.append(category)
        # Builder state selects subsequent factual scenario values; private gold
        # is recomputed later from the finished public records, not this state.
        if source_scope == self.scope:
            apply_observations(self.domains, observations)
            if new_rule:
                self.rule = new_rule
        for doc in event["documents"]:
            if doc["scope"] == self.scope:
                apply_observations(self.domains, doc["observations"])

    def invariant(self, two_dimensions=False):
        day = min(self.rule["minDays"] + 1, 6)
        hour = (self.rule["minHours"] + day - 1) // day + 1
        obs = {"days": choices(day, day + 1),
               "hours": choices(hour, hour + 1) if two_dimensions else known(hour)}
        self.add("finite_invariant", obs,
                 "排班仍在多份方案间协调，最终安排尚未核定。")

    def divergent_confirmation(self, favorable, two_dimensions=False):
        low_day = self.rule["minDays"] - 1
        high_day = self.rule["minDays"] + 1
        hour = (self.rule["minHours"] + high_day - 1) // high_day
        obs = {"days": choices(low_day, high_day),
               "hours": choices(hour - 1, hour) if two_dimensions else known(hour)}
        final = {"days": known(high_day if favorable else low_day), "hours": known(hour)}
        documents = [
            self.document(1, "本人排班核定回执", self.scope, final,
                          "此回执在本轮候选登记之后完成核定，覆盖本轮候选；不是另一个假设方案。"),
            self.unrelated_document(2),
            self.document(3, "个人设备归还登记", self.scope, {},
                          "仅登记归还一只资料夹；没有排班、岗位规则或申请状态变更。"),
        ]
        self.add("divergent_with_confirmation", obs,
                 "排班协调消息先列出尚未核定的候选。随后归档的原始回执在档案目录中；"
                 "若读取了本人核定回执，按回执的后续核定内容处理。", documents)

    def tighten(self, by_days=False, record_application=False):
        day_values, hour_values = self.domains["days"], self.domains["hours"]
        assert day_values is not None and hour_values is not None
        minimum = max(day_values) + 1 if by_days else self.rule["minDays"]
        threshold = max(d * h for d in day_values for h in hour_values) + self.tighten_margin
        self.rule_version += 1
        new_rule = rule_record(self.tid, self.scope, self.job, self.rule_version, minimum, threshold)
        obs = {"applied": known(True)} if record_application else {}
        self.add("rule_change_tighten", obs,
                 "本岗位新版规则原件已发布并随本事件提供，旧版从本轮起失效。"
                 + ("本人刚按此前安排递交了申请，回执已确认仍在途。" if record_application else ""),
                 new_rule=new_rule)

    def relax(self):
        days, hours = self.domains["days"], self.domains["hours"]
        assert days is not None and len(days) == 1 and hours is not None and len(hours) == 1
        self.rule_version += 1
        new_rule = rule_record(self.tid, self.scope, self.job, self.rule_version,
                               days[0], max(1, days[0] * hours[0] - self.relax_margin))
        self.add("rule_change_relax", {},
                 "本岗位已发布替代此前版本的新规则原件，本事件附原件全文；本人排班未再调整。",
                 new_rule=new_rule)

    def completed(self, historical=False):
        prefix = "此前不符合当时门槛期间提交的那份申请" if historical else "此前在途的申请"
        self.add("repair_completed", {"applied": known(False)},
                 prefix + "已由本人完成撤回，来源系统核实撤回成功，当前无任何在途申请，撤回事项无待办。"
                 "这条回执不改变排班或当前资格规则。")

    def unknown(self, field):
        self.add("open_unknown_" + field, {field: open_value()},
                 "本轮复核发现对应旧观测已失效，新的具体事实尚未核定；本轮档案尚无本人该字段的确认值。")

    def foreign(self):
        foreign_rule = rule_record(self.tid, self.other_scope, self.job, 1, 7, 83)
        self.add("other_scope", {"days": known(2), "hours": known(3), "applied": known(False)},
                 "同名岗位另一人的记录经群组转发；只属于标明的另一作用域，不是本人的变更通知。",
                 [self.unrelated_document()], new_rule=foreign_rule, scope=self.other_scope)

    def build(self):
        initial_rule = json.loads(json.dumps(self.rule))
        if self.variant == 0:
            self.invariant(two_dimensions=True)
            self.divergent_confirmation(False, two_dimensions=True)
            self.completed()
            self.relax()
            self.unknown("hours")
            self.foreign()
        elif self.variant == 1:
            self.foreign()
            self.invariant()
            self.tighten()
            self.completed()
            self.divergent_confirmation(True)
            self.unknown("applied")
        elif self.variant == 2:
            self.divergent_confirmation(True, two_dimensions=True)
            self.tighten(by_days=True)
            self.unknown("hours")
            self.completed()
            self.invariant(two_dimensions=True)
            self.foreign()
        else:
            self.tighten(record_application=True)
            self.divergent_confirmation(True)
            self.foreign()
            self.unknown("applied")
            self.completed(historical=True)
            self.invariant()
        return {"id": self.tid, "scope": self.scope, "rule": initial_rule,
                "initial": self.initial, "events": self.events}, self.categories


# Private oracle. It operates on the finished public trajectory and source
# scopes, not scenario labels or generated expected answers.
def worlds(domains):
    if any(domains[f] is None for f in FIELDS):
        return None
    return [dict(zip(FIELDS, values)) for values in itertools.product(*(domains[f] for f in FIELDS))]


def eligibility_support(domains, rule):
    days, hours = domains["days"], domains["hours"]
    minimum, threshold = rule["minDays"], rule["minHours"]
    if days is not None and hours is not None:
        return {d >= minimum and d * h >= threshold for d in days for h in hours}
    if days is not None:
        # Open hours include zero and sufficiently large nonnegative values.
        return {False, True} if any(d >= minimum and d > 0 for d in days) else {False}
    if hours is not None:
        # Open nonnegative day count permits zero; with positive hours a
        # sufficiently large count also meets the two positive thresholds.
        return {False, True} if any(h > 0 for h in hours) else {False}
    return {False, True}


def outcomes(domains, rule):
    eligible = eligibility_support(domains, rule)
    applied = domains["applied"] if domains["applied"] is not None else [False, True]
    path = {("wait" if a else "apply") if e else ("withdraw" if a else "none")
            for e in eligible for a in applied}
    supports = {"match": eligible, "path": path, "report": eligible}
    names = {"match": "eligible", "path": "next", "report": "recommend"}
    expected = {role: {names[role]: next(iter(values)) if len(values) == 1 else None}
                for role, values in supports.items()}
    statuses = {role: "current" if len(values) == 1 else "uncertain" for role, values in supports.items()}
    return expected, statuses


def private_gold(trajectory, categories):
    domains = {field: [trajectory["initial"][field]] for field in FIELDS}
    effective_rule = trajectory["rule"]
    steps = []
    for event, category in zip(trajectory["events"], categories):
        if event["scope"] == trajectory["scope"]:
            apply_observations(domains, event["observations"])
            effective_rule = event.get("rule", effective_rule)
        pre_domains = copy_domains(domains)
        pre_expected, pre_statuses = outcomes(pre_domains, effective_rule)
        read_ids = []
        for doc in event["documents"]:
            if doc["scope"] == trajectory["scope"] and doc["observations"]:
                apply_observations(domains, doc["observations"])
                read_ids.append(doc["id"])
        expected, statuses = outcomes(domains, effective_rule)
        facts = {f: domains[f][0] if domains[f] is not None and len(domains[f]) == 1 else None for f in FIELDS}
        steps.append({"eventId": event["id"], "expectedFacts": facts,
                      "expected": expected, "statuses": statuses, "category": category,
                      "domains": copy_domains(domains), "possibleWorlds": worlds(domains),
                      "preRetrievalDomains": pre_domains, "preRetrievalWorlds": worlds(pre_domains),
                      "preRetrievalExpected": pre_expected, "preRetrievalStatuses": pre_statuses,
                      "effectiveRule": effective_rule, "rule": effective_rule,
                      "factConfirmationDocumentIds": read_ids,
                      "factScoringNote": "事实参考已可检索的有效本人确认原件；未取原件而保留未知可能事实不完整。派生值与状态单独评分，不以事实分数替代。"})
    return {"id": trajectory["id"], "steps": steps}


def validate(trajectories, gold):
    assert len(trajectories) == len(gold) == 12
    assert len({t["id"] for t in trajectories}) == 12
    assert sum(len(t["events"]) for t in trajectories) == 72
    events_seen = set()
    invariant_no_change = 0
    counterexample_events = 0
    sequence_orders = set()
    for trajectory, key in zip(trajectories, gold):
        assert trajectory["id"] == key["id"]
        assert len(trajectory["events"]) == len(key["steps"]) == 6
        sequence_orders.add(tuple(s["category"] for s in key["steps"]))
        initial = trajectory["initial"]
        initial_rule = trajectory["rule"]
        previous_eligible = (initial["days"] >= initial_rule["minDays"]
                             and initial["days"] * initial["hours"] >= initial_rule["minHours"])
        transitions = set()
        previous_step = None
        for event, step in zip(trajectory["events"], key["steps"]):
            assert event["id"] not in events_seen
            events_seen.add(event["id"])
            assert event["id"] == step["eventId"]
            for source in [event] + event["documents"]:
                assert source["scope"] in source["text"]
                assert set(source["observations"]) <= set(FIELDS)
                for field, entry in source["observations"].items():
                    assert set(entry) == {"value", "alternatives"}
                    assert entry["value"] is None or entry["alternatives"] is None
                    if entry["alternatives"] is not None:
                        assert 1 < len(entry["alternatives"]) <= 2
                    values = entry["alternatives"] or ([entry["value"]] if entry["value"] is not None else [])
                    assert all(type(v) is bool if field == "applied" else type(v) is int and v >= 0 for v in values)
                    if field == "days":
                        assert all(v <= 7 for v in values)
            for field in ("possibleWorlds", "preRetrievalWorlds"):
                assert step[field] is None or 1 <= len(step[field]) <= 4
            # A second calculation path checks every public-domain combination,
            # all three consumers, and both before/after-confirmation labels.
            for domain_key, world_key, value_key, status_key in (
                ("domains", "possibleWorlds", "expected", "statuses"),
                ("preRetrievalDomains", "preRetrievalWorlds", "preRetrievalExpected", "preRetrievalStatuses"),
            ):
                domains = step[domain_key]
                if all(domains[f] is not None for f in FIELDS):
                    combinations = list(itertools.product(*(domains[f] for f in FIELDS)))
                    assert step[world_key] == [dict(zip(FIELDS, w)) for w in combinations]
                else:
                    assert step[world_key] is None
                    # Every generated open numeric field is hours. Zero and
                    # threshold+1 witness both sides whenever day-count permits
                    # eligibility; a failing day-count makes every hour fail.
                    assert domains["days"] is not None
                    alternatives = [domains[f] if domains[f] is not None else
                                    ([False, True] if f == "applied" else [0, step["rule"]["minHours"] + 1])
                                    for f in FIELDS]
                    combinations = list(itertools.product(*alternatives))
                supported = {role: set() for role in ("match", "path", "report")}
                for days, hours, applied in combinations:
                    eligible = days >= step["rule"]["minDays"] and days * hours >= step["rule"]["minHours"]
                    next_action = {(True, False): "apply", (True, True): "wait",
                                   (False, True): "withdraw", (False, False): "none"}[eligible, applied]
                    supported["match"].add(eligible)
                    supported["path"].add(next_action)
                    supported["report"].add(eligible)
                for role, field in (("match", "eligible"), ("path", "next"), ("report", "recommend")):
                    expected_value = next(iter(supported[role])) if len(supported[role]) == 1 else None
                    assert step[value_key][role][field] == expected_value
                    assert step[status_key][role] == ("current" if len(supported[role]) == 1 else "uncertain")
            assert step["expectedFacts"] == {
                f: step["domains"][f][0] if step["domains"][f] is not None and len(step["domains"][f]) == 1 else None
                for f in FIELDS
            }
            if step["category"] == "divergent_with_confirmation":
                assert step["preRetrievalStatuses"]["match"] == "uncertain"
                assert step["statuses"]["match"] == "current"
                assert len(step["factConfirmationDocumentIds"]) == 1
                branch_values = {w["days"] >= step["rule"]["minDays"] and w["days"] * w["hours"] >= step["rule"]["minHours"]
                                 for w in step["preRetrievalWorlds"]}
                assert branch_values == {False, True}
                assert previous_eligible is not None and any(v != previous_eligible for v in branch_values)
                counterexample_events += 1
            if step["category"] == "repair_completed":
                assert step["expectedFacts"]["applied"] is False
                assert step["expected"]["path"]["next"] != "withdraw"
            if step["category"] == "other_scope":
                assert event["scope"] != trajectory["scope"]
                assert step["rule"]["id"] != event["rule"]["id"]
                if previous_step is not None:
                    assert step["domains"] == previous_step["domains"]
                    assert step["expected"] == previous_step["expected"]
                    assert step["effectiveRule"] == previous_step["effectiveRule"]
            current_eligible = step["expected"]["match"]["eligible"]
            if previous_eligible is not None and current_eligible is not None:
                transitions.add((previous_eligible, current_eligible))
            if step["category"] == "finite_invariant" and current_eligible == previous_eligible:
                invariant_no_change += 1
            previous_eligible, previous_step = current_eligible, step
        assert (True, False) in transitions and (False, True) in transitions
    assert len(sequence_orders) == 4
    assert counterexample_events == 12
    assert invariant_no_change >= 6
    public = json.dumps(trajectories, ensure_ascii=False)
    for forbidden in ('"expectedFacts"', '"expected"', '"statuses"', '"possibleWorlds"', '"category"', '"gold"'):
        assert forbidden not in public


def main():
    trajectories, gold = [], []
    for job_index in range(len(JOBS)):
        for variant in range(4):
            trajectory, categories = Builder(job_index, variant).build()
            trajectories.append(trajectory)
            gold.append(private_gold(trajectory, categories))
    validate(trajectories, gold)
    (ROOT / "data").mkdir(parents=True, exist_ok=True)
    (ROOT / "private").mkdir(parents=True, exist_ok=True)
    for path, value in ((ROOT / "data/trajectories.json", trajectories), (ROOT / "private/gold.json", gold)):
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"trajectories": len(trajectories), "events": sum(len(t["events"]) for t in trajectories),
                      "rolesPerEvent": 3, "categorySequences": [list(dict.fromkeys(s["category"] for s in t["steps"])) for t in gold[:4]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
