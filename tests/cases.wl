(* Writes reference WXF files made by the kernel: build/kernel/NNN.wxf, one per case, plus
   build/kernel/cases.txt with each case in InputForm. Run through tests/run_codec_tests.sh. *)
out = FileNameJoin[{DirectoryName[$InputFileName], "..", "build", "kernel"}];
Quiet[CreateDirectory[out, CreateIntermediateDirectories -> True]];
cases = {
  0, 1, -1, 127, 128, -128, -129, 32767, 32768, -32768, -32769, 2^31 - 1, 2^31, -2^31, -2^31 - 1,
  2^63 - 1, -2^63, 2^63, -2^63 - 1, 10^100, -10^100,
  1.5, -0.25, 1.*^300, 2.2250738585072014*^-308, 3.14159`30, N[Pi, 100], 1.5`20*^-500, -2.5`25*^400,
  "", "hello", "unicode: \[Alpha]\[Beta]\[Gamma] \[Integral] \:2603", StringRepeat["long string ", 40],
  x, Global`y, Integrate[Sin[x], x], f[g[h[]]], 2/3, 1 + 2 I, 1.5 - 2.5 I, {}, {1, {2, {3}}},
  <||>, <|"a" -> 1, b :> 2, 3 -> {x}|>, x -> y, Hold[1 + 1], Missing["NotFound"],
  ByteArray[Range[0, 255]], ByteArray[{7}],
  Developer`ToPackedArray[{1, 2, 3}], Developer`ToPackedArray[{{1., 2.}, {3., 4.}, {5., 6.}}],
  Developer`ToPackedArray[{1 + 2 I, 3 - 4 I}], Developer`ToPackedArray[{10^10, -10^10}],
  Developer`ToPackedArray[{-200, 300}], Range[1000],
  NumericArray[{1, 2, 255}, "UnsignedInteger8"], NumericArray[{{1.5, -2.}}, "Real32"],
  NumericArray[{-5, 70000}, "Integer32"], NumericArray[{2^64 - 1}, "UnsignedInteger64"],
  f[x][y], Derivative[1][f][x], SparseArray[{1 -> 1, 5 -> 2}]
};
Do[BinaryWrite[FileNameJoin[{out, IntegerString[i, 10, 3] <> ".wxf"}], BinarySerialize[cases[[i]]]];
   Close[FileNameJoin[{out, IntegerString[i, 10, 3] <> ".wxf"}]], {i, Length[cases]}];
Export[FileNameJoin[{out, "cases.txt"}], StringRiffle[ToString[#, InputForm] & /@ cases, "\n"], "Text"];
Print["wrote ", Length[cases], " cases"];
