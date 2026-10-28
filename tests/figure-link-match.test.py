"""Safety cases for the offline matcher used on the real catalogue."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('figure_match', Path(__file__).parents[1] / 'scripts/figure-link-match.py')
MATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MATCH)


class MatchingSafetyTests(unittest.TestCase):
    def evaluate(self, name, title, category, members):
        file = dict(id='f', name=name, relative_path=name, sha256='a'*64, size_bytes='10', status='available')
        listing = dict(fingerprint=dict(size=10), inventoryUnchanged=True, sha256='a'*64, error=None,
                       entries=[{'Path': p, 'Folder': '-'} for p in members])
        return MATCH.evaluate(dict(id='p',title=title), [('description', name)], [file], {name: listing}, [], [category])

    def choose(self, source, *names):
        return MATCH.choose(source, [dict(id=str(i), name=name) for i, name in enumerate(names)])

    def test_two_different_packages_with_only_case_difference_are_not_auto_selected(self):
        candidates, reasons = self.choose(['2b_-_Nier_Automata.rar'], '2B_-_Nier_Automata.rar', '2b_-_Nier_Automata.rar')
        self.assertEqual(len(candidates), 2)
        self.assertTrue(reasons)

    def test_version_number_is_not_erased(self):
        candidates, reasons = self.choose(['MyPokePrints_-_Gengar_1.zip'], 'MyPokePrints_-_Gengar_2.zip')
        self.assertEqual(candidates, [])
        self.assertTrue(reasons)

    def test_support_package_is_not_interchangeable(self):
        candidates, reasons = self.choose(['Eren_Yeager_Presupported.rar'], 'Eren_Yeager_Unsupported.rar')
        self.assertEqual(candidates, [])
        self.assertTrue(reasons)

    def test_creator_is_not_discarded_for_a_similar_character(self):
        candidates, reasons = self.choose(['CW_Studio_-My_Hero_Acedemia-_Mirko'], 'Rumi_Usagiyama___40_Mirko__41__-_myAnimate.rar')
        self.assertEqual(candidates, [])
        self.assertTrue(reasons)

    def test_conflicting_import_sources_are_not_resolved_by_first_value(self):
        candidates, reasons = self.choose(['Shampoo.rar', 'Shampoo_-_KuGo_figures.rar'], 'Shampoo.rar', 'Shampoo_-_KuGo_figures.rar')
        self.assertEqual(candidates, [])
        self.assertTrue(reasons)

    def test_extension_may_resolve_a_package_but_not_case_collisions(self):
        candidates, reasons = self.choose(['2B.zip'], '2B.rar', '2B.zip')
        self.assertEqual([c['name'] for c in candidates], ['2B.zip'])
        self.assertEqual(reasons, [])

    def test_original_without_extension_can_agree_with_original_with_extension(self):
        candidates, reasons = self.choose(['ESMonster_-Elden_Ring-_Ranni', 'ESMonster_-Elden_Ring-_Ranni.rar'], 'ESMonster_-_Elden_Ring_-_Ranni.rar')
        self.assertEqual(len(candidates), 1)
        self.assertEqual(reasons, [])

    def test_name_of_studio_does_not_confirm_character_inside_archive(self):
        self.assertEqual(MATCH.identity('Azerama_-_My_Hero_Academia_-_Momo_Yaoyorozu.rar') & MATCH.tokens('Azerama/Base.stl'), set())
        self.assertIn('momo', MATCH.identity('Azerama_-_My_Hero_Academia_-_Momo_Yaoyorozu.rar'))

    def test_one_piece_mesh_is_not_mistaken_for_one_piece_franchise(self):
        result = self.evaluate('Blue_Spray_-_Alphonse_Elric.rar', 'Alphonse Elric', 'Стальной Алхимик',
                               ['Blue Spray - Alphonse Elric/one_piece.stl'])
        self.assertEqual(result['status'], 'ready')

    def test_explicit_franchise_conflict_is_left_for_review(self):
        result = self.evaluate('CW_Studio_-_Honkai_-_Acheron.zip', 'Acheron', 'Genshin Impact', ['Honkai/Acheron/Base.stl'])
        self.assertNotEqual(result['status'], 'ready')

    def test_title_conflict_is_not_hidden_by_exact_original_filename(self):
        result = self.evaluate('Zoro_Rafael_-_Goku__Vazador.rar', 'Зоро - Ван пис', 'One Peace', ['Goku/Base.stl'])
        self.assertNotEqual(result['status'], 'ready')

    def test_nsfw_variant_requires_package_evidence(self):
        result = self.evaluate('Daki_Demon_Slayer_NSFW.rar', 'Daki', 'Demon Slayer', ['Daki/SFW/Body.stl'])
        self.assertNotEqual(result['status'], 'ready')

    def test_one_member_of_a_pair_does_not_prove_the_whole_composition(self):
        result = self.evaluate('Elias_and_Chise.zip', 'Elias and Chise', 'Nou Name', ['Elias/Body.stl'])
        self.assertNotEqual(result['status'], 'ready')


if __name__ == '__main__':
    unittest.main()
