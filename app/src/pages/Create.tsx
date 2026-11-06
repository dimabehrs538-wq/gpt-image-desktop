import { Wand2 } from "lucide-react";
import { PageHeader } from "@/components/common";
import { Composer } from "@/components/Composer";

export default function Create() {
  return (
    <>
      <PageHeader icon={Wand2} title="创作工作台" desc="文生图 · 调用 /images/generations，结果自动保存到本地输出目录" />
      <Composer mode="generate" />
    </>
  );
}
