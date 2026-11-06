import { ImagePlus } from "lucide-react";
import { PageHeader } from "@/components/common";
import { Composer } from "@/components/Composer";

export default function Edit() {
  return (
    <>
      <PageHeader icon={ImagePlus} title="图生图 / 编辑" desc="上传一张或多张参考图（可选蒙版），调用 /images/edits 进行编辑与合成" />
      <Composer mode="edit" />
    </>
  );
}
