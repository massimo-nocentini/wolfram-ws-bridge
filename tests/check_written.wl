(* Reads build/written/w_NN.wxf made by codec_test and compares them with the expected expressions. *)
dir = FileNameJoin[{DirectoryName[$InputFileName], "..", "build", "written"}];
(* the first case must stay unevaluated; the others are compared as evaluated values *)
expected = {
  HoldComplete[Integrate[Global`x^2 Sin[Global`x], Global`x]],
  {0, -1, 127, 128, -129, 40000, -40000, 3000000000, -2^63, 2^63 - 1},
  {-123456789012345678901234567890, 0.1, -1.*^300,
    3.14159265358979323846264338327950288`35., "caf\[EAcute] \[Integral]", ByteArray[{0, 1, 2, 254, 255}]},
  <|"a" -> 1, "b" :> {}|>,
  {{1., 2., 3.}, {4., 5., 6.}},
  NumericArray[{1, 2, 250}, "UnsignedInteger8"]
};
results = Table[
  With[{got = BinaryDeserialize[ReadByteArray[FileNameJoin[{dir, "w_" <> IntegerString[i - 1, 10, 2] <> ".wxf"}]], HoldComplete]},
    If[If[i == 1, got, ReleaseHold[got]] === expected[[i]], True, Print["FAIL w_", i - 1, ": ", InputForm[got]]; False]],
  {i, Length[expected]}];
Print["kernel check of written files: ", Count[results, True], " of ", Length[results], " match"];
